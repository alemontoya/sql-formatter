INSERT INTO view_financial_forecast_feed_data
WITH   transaction_amounts_in_cad AS
       (SELECT DISTINCT
               DATE_TRUNC(MONTH, TO_DATE(f.created_date_key, 'YYYYMMDD')) AS transaction_month,
               c.landr_user_id AS customer_id,
               REPLACE(s.subscription_id, 'fuse_sub_', '') AS subscription_id,
               f.plan_cycle_key,
               f.product_cycle_key,
               cur.currency,
               IFF(cur.currency = 'USD', 1.00, fx_to_usd.rate_to_from) AS rate_to_usd,
               fx_to_cad.rate_from_to AS rate_to_cad,
               --
               f.invoice_discount_percent_off AS pct_discount_off,
               -- In original currency
               f.invoice_orig_curr_subtotal_excluding_tax_decimal AS subtotal_orig_currency,
               f.invoice_orig_curr_total_excluding_tax_decimal AS total_orig_currency,
               -- In USD
               ROUND(f.invoice_orig_curr_subtotal_excluding_tax_decimal * rate_to_usd, 2) AS subtotal_in_usd,
               ROUND(f.invoice_orig_curr_total_excluding_tax_decimal * rate_to_usd, 2) AS total_in_usd,
               -- In CAD
               ROUND(subtotal_in_usd * rate_to_cad, 2) AS subtotal_in_cad,
               ROUND(total_in_usd * rate_to_cad, 2) AS total_in_cad
          FROM fact_transactions AS f
          JOIN dim_currencies AS cur
            ON cur.currency_key = f.original_currency_key
          JOIN dim_subscriptions AS s
            ON s.subscription_key = f.subscription_key
          JOIN dim_customers AS c
            ON c.customer_key = f.customer_key
          LEFT JOIN ref_currency_exchange_rates_usd AS fx_to_usd
            ON fx_to_usd.to_currency = cur.currency
           AND fx_to_usd.rate_date = TO_DATE(f.created_date_key, 'YYYYMMDD')
          LEFT JOIN ref_currency_exchange_rates_usd AS fx_to_cad
            ON fx_to_cad.to_currency = 'CAD'
           AND fx_to_cad.rate_date = TO_DATE(f.created_date_key, 'YYYYMMDD')
       ),
       month_list AS 
       (SELECT DISTINCT DATE_TRUNC(MONTH, TO_DATE("calendar_date")) AS active_month
          FROM "dim_dates"
         --WHERE "calendar_date" = ADD_MONTHS(DATE_TRUNC(MONTH, CURRENT_DATE()), -1)
         WHERE "calendar_date" >= ADD_MONTHS(DATE_TRUNC(MONTH, CURRENT_DATE()), -12)
           AND "calendar_date" < CURRENT_DATE()
       ),
       churn_count AS
       (SELECT CASE
                 WHEN pc.plan_code LIKE 'sos%' OR pc.plan_code LIKE 'kvr%' THEN 'LANDR Inside'
                 WHEN pc.plan_code||'_'||pc.subscription_interval = 'studio_essentials_distro_mobile_Monthly' THEN 'Bundles ALC'
                 WHEN pr.plan_family = 'SynchroArtsSubscription' THEN 'Bundles'
                 ELSE pr.plan_family
               END AS plan_family,
               ml.active_month,
               COUNT(DISTINCT pr.customer_id) AS churn_users
          FROM month_list AS ml
          JOIN product_cycles AS pr
            ON pr.cycle_end_month = ml.active_month
          JOIN plan_cycles as pc
            ON pc.product_cycle_id = pr.product_cycle_id
           AND pc.cycle_end_month = ml.active_month
         WHERE pr.plan_family != 'Reason'
         GROUP BY 1, 2
       ),
       new_subs AS 
       (SELECT CASE
                 WHEN pc.plan_code LIKE 'sos%' OR pc.plan_code LIKE 'kvr%' THEN 'LANDR Inside'
                 WHEN pc.plan_code||'_'||pc.subscription_interval = 'studio_essentials_distro_mobile_Monthly' THEN 'Bundles ALC'
                 WHEN pr.plan_family = 'SynchroArtsSubscription' THEN 'Bundles'
                 ELSE pr.plan_family
               END AS plan_family,
               ml.active_month,
               COUNT(DISTINCT pr.customer_id) AS new_subs
          FROM month_list AS ml
          JOIN product_cycles AS pr
            ON pr.cycle_start_month = ml.active_month
          JOIN plan_cycles as pc
            ON pc.product_cycle_id = pr.product_cycle_id
           AND pc.cycle_start_month = ml.active_month
         WHERE pr.plan_family != 'Reason'
         GROUP BY 1, 2
       ),
       active_users AS
       (SELECT CASE
                 WHEN pc.plan_code LIKE 'sos%' OR pc.plan_code LIKE 'kvr%' THEN 'LANDR Inside'
                 WHEN pc.plan_code||'_'||pc.subscription_interval = 'studio_essentials_distro_mobile_Monthly' THEN 'Bundles ALC'
                 WHEN pr.plan_family = 'SynchroArtsSubscription' THEN 'Bundles'
                 ELSE pr.plan_family
               END AS plan_family,
               ml.active_month,
               COUNT(DISTINCT pr.customer_id) AS active_users
          FROM month_list AS ml
          JOIN product_cycles AS pr 
            ON pr.cycle_start_month <= ml.active_month 
           AND ml.active_month < NVL(pr.cycle_end_month, CURRENT_DATE())
          JOIN plan_cycles as pc
            ON pc.product_cycle_id = pr.product_cycle_id
           AND pc.cycle_start_month <= ml.active_month 
           AND ml.active_month < NVL(pc.cycle_end_month, CURRENT_DATE())
           --AND pc.plan_code != 'studio_essentials_distro_mobile'
         WHERE pr.plan_family != 'Reason'
         GROUP BY 1, 2
       ),
       active_renewal_monthly AS
       (SELECT CASE
                 WHEN pl.plan_code LIKE 'sos%' OR pl.plan_code LIKE 'kvr%' THEN 'LANDR Inside'
                 WHEN pl.plan_code||'_'||pl.subscription_interval = 'studio_essentials_distro_mobile_Monthly' THEN 'Bundles ALC'
                 WHEN pl.plan_family = 'SynchroArtsSubscription' THEN 'Bundles'
                 ELSE pl.plan_family
               END AS plan_family,
               ml.active_month,
               COUNT(DISTINCT IFF((pl.subscription_interval = 'Yearly' AND 
                                   MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month)
                                  ) 
                                  OR pl.SUBSCRIPTION_INTERVAL <> 'Yearly', pl.subscription_id, NULL)) AS total_renewals,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Monthly', pl.subscription_id, NULL)) AS monthly_renewal,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Annual Billed Monthly', pl.subscription_id, NULL)) AS abm_renewal,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Yearly' AND MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month), pl.subscription_id, NULL)) AS yearly_renewal,
               -- Avg amount paid including discounts
               AVG(IFF((pl.subscription_interval = 'Yearly' AND 
                         MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month)
                        ) 
                        OR pl.SUBSCRIPTION_INTERVAL <> 'Yearly', NULLIFZERO(f.total_in_cad), NULL)) AS total_renewal_avg_amount_including_discounts,
               AVG(IFF(pl.subscription_interval = 'Monthly', NULLIFZERO(f.total_in_cad), NULL)) AS monthly_renewal_avg_amount_including_discounts,
               AVG(IFF(pl.subscription_interval = 'Annual Billed Monthly', NULLIFZERO(f.total_in_cad), NULL)) AS abm_renewal_avg_amount_including_discounts,
               AVG(IFF(pl.subscription_interval = 'Yearly' AND MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month), NULLIFZERO(f.total_in_cad), NULL)) AS yearly_renewal_avg_amount_including_discounts,
               -- Avg pct discount off
               AVG(IFF((pl.subscription_interval = 'Yearly' AND 
                         MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month)
                        ) 
                        OR pl.SUBSCRIPTION_INTERVAL <> 'Yearly', NULLIFZERO(ABS(f.pct_discount_off)), NULL)) AS total_renewal_avg_pct_discount,
               AVG(IFF(pl.subscription_interval = 'Monthly', NULLIFZERO(ABS(f.pct_discount_off)), NULL)) AS monthly_renewal_avg_pct_discount,
               AVG(IFF(pl.subscription_interval = 'Annual Billed Monthly', NULLIFZERO(ABS(f.pct_discount_off)), NULL)) AS abm_renewal_avg_pct_discount,
               AVG(IFF(pl.subscription_interval = 'Yearly'AND MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month), NULLIFZERO(ABS(f.pct_discount_off)), NULL)) AS yearly_renewal_avg_pct_discount,
               -- Avg amount paid excluding discounts
               AVG(IFF((pl.subscription_interval = 'Yearly' AND 
                         MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month)
                        ) 
                        OR pl.SUBSCRIPTION_INTERVAL <> 'Yearly', NULLIFZERO(f.subtotal_in_cad), NULL)) AS total_renewal_avg_amount_excluding_discounts,
               AVG(IFF(pl.subscription_interval = 'Monthly', NULLIFZERO(f.subtotal_in_cad), NULL)) AS monthly_renewal_avg_amount_excluding_discounts,
               AVG(IFF(pl.subscription_interval = 'Annual Billed Monthly', NULLIFZERO(f.subtotal_in_cad), NULL)) AS abm_renewal_avg_amount_excluding_discounts,
               AVG(IFF(pl.subscription_interval = 'Yearly'AND MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month), NULLIFZERO(f.subtotal_in_cad), NULL)) AS yearly_renewal_avg_amount_excluding_discounts,
               -- Renewals with discount
               COUNT(DISTINCT IFF(((pl.subscription_interval = 'Yearly' AND 
                                   MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month)
                                  ) 
                                  OR pl.SUBSCRIPTION_INTERVAL <> 'Yearly') AND NVL(f.pct_discount_off, 0) > 0, pl.subscription_id, NULL)) AS total_renewals_with_discount,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Monthly' AND NVL(f.pct_discount_off, 0) > 0, pl.subscription_id, NULL)) AS monthly_renewal_with_discount,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Annual Billed Monthly' AND NVL(f.pct_discount_off, 0) > 0, pl.subscription_id, NULL)) AS abm_renewal_with_discount,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Yearly' AND MONTH(pl.CYCLE_START_MONTH) = MONTH(ml.active_month) AND NVL(f.pct_discount_off, 0) > 0, pl.subscription_id, NULL)) AS yearly_renewal_with_discount
          FROM month_list AS ml
          JOIN plan_cycles AS pl 
            ON pl.cycle_start_month < ml.active_month 
           AND ml.active_month < NVL(pl.cycle_end_month, CURRENT_DATE()) -- the difference IS that  active_month IS surely higher than START date
           --AND pl.plan_code != 'studio_essentials_distro_mobile'
          LEFT JOIN transaction_amounts_in_cad AS f
            ON f.subscription_id = pl.subscription_id
           AND f.transaction_month = ml.active_month
           --AND f.plan_cycle_key = pl.plan_cycle_key
           --AND f.customer_id = pl.customer_id
         --WHERE pl.plan_cycle_key = '8f44c54f36d05f7a4c03d0ab1ea9f0ae0a9378ce71e1b7c10717f40381e985e1'
         WHERE pl.plan_family != 'Reason'
         GROUP BY 1,2
       ),
       new_subs_segments AS
       (SELECT CASE
                 WHEN plan_code LIKE 'sos%' OR plan_code LIKE 'kvr%' THEN 'LANDR Inside'
                 WHEN plan_code||'_'||subscription_interval = 'studio_essentials_distro_mobile_Monthly' THEN 'Bundles ALC'
                 WHEN plan_family = 'SynchroArtsSubscription' THEN 'Bundles'
                 ELSE plan_family
               END AS plan_family,
               plan_code,
               cycle_start_month,
               --
               COUNT(DISTINCT pl.subscription_id) new_subs,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Monthly', pl.subscription_id, NULL)) AS new_monthly_sub,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Annual Billed Monthly', pl.subscription_id, NULL)) AS new_abm_sub,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Yearly', pl.subscription_id, NULL)) AS new_yearly_sub,
               --
               -- Avg amount paid including discounts
               AVG(NULLIFZERO(f.total_in_cad)) AS new_subs_avg_amount_including_discounts,
               AVG(IFF(pl.subscription_interval = 'Monthly', NULLIFZERO(f.total_in_cad), NULL)) AS new_monthly_subs_avg_amount_including_discounts,
               AVG(IFF(pl.subscription_interval = 'Annual Billed Monthly', NULLIFZERO(f.total_in_cad), NULL)) AS new_abm_subs_avg_amount_including_discounts,
               AVG(IFF(pl.subscription_interval = 'Yearly', NULLIFZERO(f.total_in_cad), NULL)) AS new_yearly_subs_avg_amount_including_discounts,
               -- Avg pct discount off
               AVG(NULLIFZERO(ABS(f.pct_discount_off))) AS new_subs_renewal_avg_pct_discount,
               AVG(IFF(pl.subscription_interval = 'Monthly', NULLIFZERO(ABS(f.pct_discount_off)), NULL)) AS new_monthly_subs_avg_pct_discount,
               AVG(IFF(pl.subscription_interval = 'Annual Billed Monthly', NULLIFZERO(ABS(f.pct_discount_off)), NULL)) AS new_abm_subs_avg_pct_discount,
               AVG(IFF(pl.subscription_interval = 'Yearly', NULLIFZERO(ABS(f.pct_discount_off)), NULL)) AS new_yearly_subs_avg_pct_discount,
               -- Avg amount paid excluding discounts
               AVG(NULLIFZERO(f.subtotal_in_cad)) AS new_subs_avg_amount_excluding_discounts,
               AVG(IFF(pl.subscription_interval = 'Monthly', NULLIFZERO(f.subtotal_in_cad), NULL)) AS new_monthly_subs_avg_amount_excluding_discounts,
               AVG(IFF(pl.subscription_interval = 'Annual Billed Monthly', NULLIFZERO(f.subtotal_in_cad), NULL)) AS new_abm_subs_avg_amount_excluding_discounts,
               AVG(IFF(pl.subscription_interval = 'Yearly', NULLIFZERO(f.subtotal_in_cad), NULL)) AS new_yearly_subs_avg_amount_excluding_discounts,
               -- New subs with discount
               COUNT(DISTINCT IFF(NVL(f.pct_discount_off, 0) > 0, pl.subscription_id, NULL)) AS new_subs_with_discount,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Monthly' AND NVL(f.pct_discount_off, 0) > 0, pl.subscription_id, NULL)) AS new_monthly_subs_with_discount,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Annual Billed Monthly' AND NVL(f.pct_discount_off, 0) > 0, pl.subscription_id, NULL)) AS new_abm_subs_with_discount,
               COUNT(DISTINCT IFF(pl.subscription_interval = 'Yearly' AND NVL(f.pct_discount_off, 0) > 0, pl.subscription_id, NULL)) AS new_yearly_subs_with_discount
          FROM plan_cycles AS pl
          LEFT JOIN transaction_amounts_in_cad AS f
            ON f.subscription_id = pl.subscription_id
           AND f.transaction_month = pl.cycle_start_month
           --AND f.plan_cycle_key = pl.plan_cycle_key
           --AND f.customer_id = pl.customer_id
         --WHERE pl.plan_code != 'studio_essentials_distro_mobile'
         WHERE pl.plan_family != 'Reason'
         GROUP BY 1,2,3
       ),
       parsed_users_with_studio_distro_through_resellers AS
       (SELECT "user_id" AS user_id,
               "received_at" AS received_at,
               PARSE_JSON("parsed_json") AS parsed_json, 
               REPLACE(GET(PARSE_JSON("parsed_json"), 'partner_name'), '"') AS partner_name,
               REPLACE(GET(PARSE_JSON("parsed_json"), 'product_name'), '"') AS product_name,
               REPLACE(GET(PARSE_JSON("parsed_json"), 'product_type'), '"') AS product_type
          FROM "item_redeemed"       
         WHERE GET(PARSE_JSON("parsed_json"), 'partner_name') IN ('xchange', 'Sweetwater')
           AND GET(PARSE_JSON("parsed_json"), 'product_name') = '1Y LANDR Studio Pro'
       ),
       users_with_studio_distro_through_resellers AS
       (SELECT TO_DATE(DATE_TRUNC(MONTH, received_at::TIMESTAMP_NTZ)) AS redemption_month,
               product_name,
               partner_name,
               product_type,
               COUNT(DISTINCT user_id) AS count_of_users
          FROM parsed_users_with_studio_distro_through_resellers
         WHERE received_at::TIMESTAMP_NTZ >= ADD_MONTHS(DATE_TRUNC(MONTH, CURRENT_DATE()), -1)
         GROUP BY 1,2,3,4
       ),
       unioned_data AS
       (SELECT '01. Churned Users' AS metric_name,
               NVL(plan_family, 'N/A') AS plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               churn_users AS metric_value
          FROM churn_count AS cc
        UNION ALL
        SELECT '02. New subs' AS metric_name,
               NVL(plan_family, 'N/A') AS plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               new_subs AS metric_value
          FROM new_subs AS ns
        UNION ALL
        SELECT '03. Active users' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               active_users AS metric_value
          FROM active_users AS au 
        UNION ALL
        SELECT '04. Total renewals' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               total_renewals AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '05. Total renewals with discount' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               total_renewals_with_discount AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '06. Total renewals - Avg Amount paid excluding discounts' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(total_renewal_avg_amount_excluding_discounts , 2)AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '07. Total renewals - Avg discounts %' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(total_renewal_avg_pct_discount, 2) AS metric_value
          FROM active_renewal_monthly  
        UNION ALL
        SELECT '08. Total renewals - Avg Amount paid including discounts' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(total_renewal_avg_amount_including_discounts, 2) AS metric_value
          FROM active_renewal_monthly  
        UNION ALL
        SELECT '09. Monthly renewals' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               monthly_renewal AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '10. Monthly renewals with discount' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               monthly_renewal_with_discount AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '11. Monthly renewals - Avg Amount paid excluding discounts' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(monthly_renewal_avg_amount_excluding_discounts, 2) AS metric_value
          FROM active_renewal_monthly  
        UNION ALL
        SELECT '12. Monthly renewals - Avg discounts %' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(monthly_renewal_avg_pct_discount, 2) AS metric_value
          FROM active_renewal_monthly  
        UNION ALL
        SELECT '13. Monthly renewals - Avg Amount paid including discounts' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(monthly_renewal_avg_amount_including_discounts, 2) AS metric_value
          FROM active_renewal_monthly  
        UNION ALL
        SELECT '14. Annual billed monthly renewals' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               abm_renewal AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '15. Annual billed monthly renewals with discount' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               abm_renewal_with_discount AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '16. Annual billed monthly renewals - Avg Amount paid excluding discounts' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(abm_renewal_avg_amount_excluding_discounts, 2) AS metric_value
          FROM active_renewal_monthly  
        UNION ALL
        SELECT '17. Annual billed monthly renewals - Avg discounts %' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(abm_renewal_avg_pct_discount, 2) AS metric_value
          FROM active_renewal_monthly  
        UNION ALL
        SELECT '18. Annual billed monthly renewals - Avg Amount paid including discounts' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(abm_renewal_avg_amount_including_discounts, 2) AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '19. Yearly renewals' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               yearly_renewal AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '20. Yearly renewals with discount' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               yearly_renewal_with_discount AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '21. Yearly renewals - Avg Amount paid excluding discounts' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(yearly_renewal_avg_amount_excluding_discounts, 2) AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '22. Yearly renewals - Avg discounts %' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(yearly_renewal_avg_pct_discount, 2) AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '23. Yearly renewals - Avg Amount paid including discounts' AS metric_name,
               plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               ROUND(yearly_renewal_avg_amount_including_discounts, 2) AS metric_value
          FROM active_renewal_monthly
        UNION ALL
        SELECT '24. New subs on segment' AS metric_name,
               plan_family,
               'All' AS plan_code,
               cycle_start_month AS metric_month,
               SUM(new_subs) AS metric_value
          FROM new_subs_segments
         GROUP BY 1,2,3,4
        UNION ALL
        SELECT '25. New subs on plan' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               new_subs AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '26. New monthly subs on plan' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               new_monthly_sub AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '27. New monthly subs on plan with discount' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               new_monthly_subs_with_discount AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '28. New monthly subs on plan - Avg Amount paid excluding discounts' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               ROUND(new_monthly_subs_avg_amount_excluding_discounts, 2) AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '29. New monthly subs on plan - Avg discounts %' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               ROUND(new_monthly_subs_avg_pct_discount, 2) AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '30. New monthly subs on plan - Avg Amount paid including discounts' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               ROUND(new_monthly_subs_avg_amount_including_discounts, 2) AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '31. New yearly subs on plan' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               new_yearly_sub AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '32. New yearly subs on plan with discount' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               new_yearly_subs_with_discount AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '33. New yearly subs on plan - Avg Amount paid excluding discounts' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               ROUND(new_yearly_subs_avg_amount_excluding_discounts, 2) AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '34. New yearly subs on plan - Avg discounts %' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               ROUND(new_yearly_subs_avg_pct_discount, 2) AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '35. New yearly subs on plan - Avg Amount paid including discounts' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               ROUND(new_yearly_subs_avg_amount_including_discounts, 2) AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '36. New Annual Billed Monthly subs on plan' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               new_abm_sub AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '37. New Annual Billed Monthly subs on plan with discount' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               new_abm_subs_with_discount AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '38. New Annual Billed Monthly subs on plan - Avg Amount paid excluding discounts' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               ROUND(new_abm_subs_avg_amount_excluding_discounts, 2) AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '39. New Annual Billed Monthly subs on plan - Avg discounts %' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               ROUND(new_abm_subs_avg_pct_discount, 2) AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '40. New Annual Billed Monthly subs on plan - Avg Amount paid including discounts' AS metric_name,
               plan_family,
               plan_code,
               cycle_start_month AS metric_month,
               ROUND(new_abm_subs_avg_amount_including_discounts, 2) AS metric_value
          FROM new_subs_segments
        UNION ALL
        SELECT '41. Users with Studio purchases through resellers' AS metric_name,
               'Bundles' AS plan_family,
               partner_name || ' - ' || product_type AS plan_code,
               redemption_month AS metric_month,
               count_of_users AS metric_value
          FROM users_with_studio_distro_through_resellers
         WHERE product_name LIKE '%Studio%'
        UNION ALL
        SELECT '42. Users with Distro purchases through resellers' AS metric_name,
               'Bundles' AS plan_family,
               partner_name || ' - ' || product_type AS plan_code,
               redemption_month AS metric_month,
               count_of_users AS metric_value
          FROM users_with_studio_distro_through_resellers
         WHERE product_name LIKE '%Distro%'
        -------------------------------------
        -- Reason numbers
        -------------------------------------
        UNION ALL
        SELECT '01. Churned Users' AS metric_name,
               'Reason' AS plan_family,
               'All' AS plan_code,
               churn_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_churned_subscribers
         WHERE plan_family = 'All'
           AND plan_code = 'All'
           AND subscription_interval = 'All'
         GROUP BY 4
        UNION ALL
        SELECT '02. New subs' AS metric_name,
               'Reason' AS plan_family,
               'All' AS plan_code,
               subscription_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_new_subscribers AS ns 
         WHERE plan_family = 'All'
           AND plan_code = 'All'
           AND subscription_interval = 'All'
         GROUP BY 4
        UNION ALL
        SELECT '03. Active users' AS metric_name,
               'Reason' AS plan_family,
               'All' AS plan_code,
               active_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_active_subscribers
         WHERE plan_family = 'All'
           AND plan_code = 'All'
           AND subscription_interval = 'All'
         GROUP BY 4
        UNION ALL
        SELECT '04. Total renewals' AS metric_name,
               'Reason' AS plan_family,
               'All' AS plan_code,
               renewal_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_renewal_subscribers
         WHERE plan_family = 'All'
           AND plan_code = 'All'
           AND subscription_interval = 'All'
         GROUP BY 4
        UNION ALL
        SELECT '09. Monthly renewals' AS metric_name,
               'Reason' AS plan_family,
               'All' AS plan_code,
               renewal_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_renewal_subscribers
         WHERE plan_family = 'All'
           AND plan_code != 'All'
           AND subscription_interval = 'All'
           AND plan_code LIKE '%monthly%'
         GROUP BY 4
        UNION ALL
        SELECT '19. Yearly renewals' AS metric_name,
               'Reason' AS plan_family,
               'All' AS plan_code,
               renewal_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_renewal_subscribers
         WHERE plan_family = 'All'
           AND plan_code != 'All'
           AND subscription_interval = 'All'
           AND plan_code LIKE '%annual%'
         GROUP BY 4
        UNION ALL
        SELECT '25. New subs on plan' AS metric_name,
               'Reason' AS plan_family,
               plan_code AS plan_code,
               subscription_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_new_subscribers AS ns 
         WHERE plan_family = 'All'
           AND plan_code != 'All'
           AND subscription_interval = 'All'
         GROUP BY 3,4
        UNION ALL
        SELECT '26. New monthly subs on plan' AS metric_name,
               'Reason' AS plan_family,
               plan_code AS plan_code,
               subscription_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_new_subscribers AS ns 
         WHERE plan_family = 'All'
           AND plan_code != 'All'
           AND subscription_interval = 'All'
           AND plan_code LIKE '%monthly'
         GROUP BY 3,4
        UNION ALL
        SELECT '31. New yearly subs on plan' AS metric_name,
               'Reason' AS plan_family,
               plan_code AS plan_code,
               subscription_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_new_subscribers AS ns 
         WHERE plan_family = 'All'
           AND plan_code != 'All'
           AND subscription_interval = 'All'
           AND plan_code LIKE '%annual%'
         GROUP BY 3,4
        UNION ALL
        SELECT '43. Monthly Churns' AS metric_name,
               'Reason' AS plan_family,
               'All' AS plan_code,
               churn_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_churned_subscribers AS ns 
         WHERE plan_family = 'All'
           AND plan_code = 'All'
           AND subscription_interval = 'Monthly'
         GROUP BY 4
        UNION ALL
        SELECT '44. Yearly Churns' AS metric_name,
               'Reason' AS plan_family,
               'All' AS plan_code,
               churn_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_churned_subscribers AS ns 
         WHERE plan_family = 'All'
           AND plan_code = 'All'
           AND subscription_interval = 'Yearly'
         GROUP BY 4
        UNION ALL
        SELECT '45. Other Churns' AS metric_name,
               'Reason' AS plan_family,
               'All' AS plan_code,
               churn_month AS metric_month,
               SUM(total_subscribers) AS metric_value
          FROM view_reason_monthly_churned_subscribers AS ns 
         WHERE plan_family = 'All'
           AND plan_code = 'All'
           AND subscription_interval = 'N/A'
         GROUP BY 4
       )
SELECT NVL(metric_name, 'N/A') AS metric_name,
       NVL(plan_family, 'N/A') AS plan_family,
       NVL(plan_code, 'All') AS plan_code,
       NVL(metric_month, DATE_TRUNC(MONTH, CURRENT_DATE())) AS metric_month,
       metric_value
  FROM unioned_data
 WHERE metric_month >= ADD_MONTHS(DATE_TRUNC(MONTH, CURRENT_DATE()), -12)
;
