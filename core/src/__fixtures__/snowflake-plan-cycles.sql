CREATE OR REPLACE TEMPORARY TABLE temp_plan_cycles_subscriptions_extraction AS
SELECT -- **********************************************************************
       -- * First we get the columns that we need from the source table without*
       -- * any change                                                         *
       -- **********************************************************************
       payment_gateway,
       customer_id,
       application_name,
       plan_code,
       plan_family,
       subscription_id,
       fusebill_subscription_id,
       subscription_interval,
       currency,
       status,
       -- *********************************************************************
       -- * Now we add new calculated columns tha will be needed for some     *
       -- * comparisons further down                                          *
       -- *********************************************************************
       --
       -- mod_plan_code: There are some plans that have a different name but need
       -- to be accounted as the same
       CASE
         WHEN plan_code LIKE 'mastering_credits_unlimited_%' THEN 'mastering_credits_unlimited'
         WHEN plan_code = 'd2' THEN 'distribution_tier2'
         WHEN plan_code = 'd1' THEN 'distribution_tier1'
         WHEN plan_code LIKE '%_pause' THEN REPLACE(plan_code, '_pause')
         ELSE plan_code
       END AS mod_plan_code,
       --
       -- _transaction_date: Has the transaction date in UTC time
       CASE
         WHEN payment_gateway = 'Stripe' THEN CONVERT_TIMEZONE('UTC', transaction_date::TIMESTAMP_TZ)
         ELSE transaction_date::TIMESTAMP_TZ
       END AS _transaction_date,
       --
       -- prior_transaction_date: Has the value of the prior record's transaction
       --                         date in UTC time
       -- next_transaction_date: Has the value of the next record's transaction
       --                        date in UTC time
       -- months_between_prior_txn_date: Has the number of months between the prior
       --                                record's transaction date and the current's
       --                                one
       -- We calculate the time that has passed between 2 transactions to see if
       -- they are consecutive or not
       LAG(_transaction_date, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY _transaction_date) AS prior_transaction_date,
       LEAD(_transaction_date, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY _transaction_date) AS next_transaction_date,
       ROUND(MONTHS_BETWEEN(_transaction_date, prior_transaction_date),0) AS months_between_prior_txn_date,
       --
       -- months_to_add: Calculate a number of months to be added to the a particular
       --                transaction based on the interval so we can compare against
       --                the next transaction to identify if they are consecutive or not.
       CASE
         WHEN subscription_interval != 'Yearly' THEN 1
         WHEN subscription_interval = 'Yearly' THEN 12
       END AS months_to_add,
       --
       -- _subscription_created_at: Start date of the subscription in UTC time
       CASE
         WHEN payment_gateway = 'Stripe' THEN CONVERT_TIMEZONE('UTC', subscription_created_at::TIMESTAMP_TZ)
         ELSE subscription_created_at::TIMESTAMP_TZ
       END AS _subscription_created_at,
       --
       -- _subscription_end_date: End date of the subscription in UTC time
       CASE
         WHEN payment_gateway = 'Stripe' THEN CONVERT_TIMEZONE('UTC', subscription_end_date::TIMESTAMP_TZ)
         ELSE subscription_end_date::TIMESTAMP_TZ
      END AS _subscription_end_date,
      --
      -- next_fusebill_subscription_id: Next record's values of the fusebill
      --                                subscription id
      LEAD(fusebill_subscription_id, 1) OVER(PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS next_fusebill_subscription_id,
      --
      -- next_payment_gateway: Next record's values of the payment gateway
      LEAD(payment_gateway, 1) OVER(PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS next_payment_gateway,
      --
      -- We need to calculate if there's a change of customer, plan family and plan code
      -- between 2 records, so we calculate the prior values for these columns
      LAG(customer_id, 1) OVER (PARTITION BY customer_id ORDER BY transaction_date) AS prior_customer_id,
      LAG(plan_family, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS prior_plan_family,
      LAG(mod_plan_code, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS prior_mod_plan_code,
      LAG(subscription_interval, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS prior_subscription_interval,
      --
      -- We will also calculate the change against the next record
      LEAD(customer_id, 1) OVER (PARTITION BY customer_id ORDER BY transaction_date) AS next_customer_id,
      LEAD(plan_family, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS next_plan_family,
      LEAD(mod_plan_code, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS next_mod_plan_code,
      LEAD(subscription_interval, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS next_subscription_interval,
      LEAD(subscription_id, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS next_subscription_id,
      --
      -- Are the values, when compared to the prior record, the same?
      customer_id = NVL(prior_customer_id, 'N/A') AS same_prior_customer_id,
      plan_family = NVL(prior_plan_family, 'N/A') AS same_prior_plan_family,
      mod_plan_code = NVL(prior_mod_plan_code, 'N/A') AS same_prior_plan_code,
      subscription_interval = NVL(prior_subscription_interval, 'N/A') AS same_prior_subscription_interval,
      --
      -- Are the values, when compared to the next record, the same?
      customer_id = NVL(next_customer_id, 'N/A') AS same_next_customer_id,
      plan_family = NVL(next_plan_family, 'N/A') AS same_next_plan_family,
      mod_plan_code = NVL(next_mod_plan_code, 'N/A') AS same_next_plan_code,
      subscription_id = NVL(next_subscription_id, 'N/A') AS same_next_subscription_id,
      --
      -- By gettting the prior value for the number of months to add we can compare if the number of months
      -- that have passed is the same as the number of months that should have passed, based on the subscription
      -- interval, to make 2 transactions consecutive
      LAG(months_to_add, 1) OVER (PARTITION BY customer_id, plan_family ORDER BY transaction_date) AS prior_months_to_add,
      --
      -- plan_paused: Boolean value to see if the plan is a pause plan or not
      IFF(plan_code LIKE '%_pause', 'Paused', 'Not Paused') AS plan_paused,
      --
      -- last_plan_status: Gets the status of the last invoice of the plan cycle
      LAST_VALUE(status) OVER (PARTITION BY customer_id, plan_family, mod_plan_code ORDER BY _transaction_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_plan_status,
      --
      -- last_position: It flags with 1 the last record of the plan cycle
      ROW_NUMBER() OVER (PARTITION BY customer_id, plan_family, mod_plan_code ORDER BY _transaction_date DESC) AS last_position,
      --
      -- is_first_position: It flags with 1 the first record of the plan cycle
      ROW_NUMBER() OVER (PARTITION BY customer_id, plan_family ORDER BY _transaction_date) = 1 AS is_first_position,
      --
      -- last_plan_paused: Gets the pause status of the last invoice of the plan cycle
      LAST_VALUE(plan_paused) OVER (PARTITION BY customer_id, plan_family, mod_plan_code ORDER BY _transaction_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_plan_paused
 FROM stripe_fusebill_exploded_invoices
WHERE status NOT LIKE 'incomplete%'
;