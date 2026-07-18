CREATE OR REPLACE TEMPORARY TABLE _stg_daily_status AS
WITH src AS (
    SELECT
        uau_user_id,
        subscription_date,

        -- Studio (umbrella + per-plan)
        has_studio_subscription_monthly,
        has_studio_subscription_yearly,
        has_studio_pro_subscription_monthly,
        has_studio_pro_subscription_yearly,
        has_studio_standard_subscription_monthly,
        has_studio_standard_subscription_yearly,
        has_studio_essentials_subscription_monthly,
        has_studio_essentials_subscription_yearly,
        has_studio_mobile_subscription_monthly,
        has_studio_mobile_subscription_yearly,

        -- Distribution (umbrella + per-plan)
        has_distribution_subscription_monthly,
        has_distribution_subscription_yearly,
        has_distribution_basic_subscription_monthly,
        has_distribution_basic_subscription_yearly,
        has_distribution_pro_subscription_monthly,
        has_distribution_pro_subscription_yearly,
        has_distribution_other_subscription_monthly,
        has_distribution_other_subscription_yearly,

        -- Reason (umbrella - per-plan)
        has_reason_subscription_monthly,
        has_reason_subscription_yearly,
        has_reason_rack_subscription_monthly,
        has_reason_rack_subscription_yearly,
        has_reason_plus_subscription_monthly,
        has_reason_plus_subscription_yearly,        

        -- Standalone products
        has_chromatic_subscription_monthly,
        has_chromatic_subscription_yearly,
        has_gen_ai_subscription_monthly,
        has_gen_ai_subscription_yearly,
        has_mastering_subscription_monthly,
        has_mastering_subscription_yearly,
        has_learn_subscription_monthly,
        has_learn_subscription_yearly,
        has_samples_subscription_monthly,
        has_samples_subscription_yearly,
        has_sessions_subscription_monthly,
        has_sessions_subscription_yearly,
        has_storage_subscription_monthly,
        has_storage_subscription_yearly,
        has_synchroarts_subscription_monthly,
        has_synchroarts_subscription_yearly
    FROM temp_intermediate_landr_subscribers_by_day
    ),

unpivoted AS (
    SELECT
        uau_user_id,
        subscription_date,
        LOWER(product_stream) AS product_stream,
        daily_status
    FROM src
    UNPIVOT INCLUDE NULLS ( daily_status FOR product_stream IN (
        has_studio_subscription_monthly,
        has_studio_subscription_yearly,
        has_studio_pro_subscription_monthly,
        has_studio_pro_subscription_yearly,
        has_studio_standard_subscription_monthly,
        has_studio_standard_subscription_yearly,
        has_studio_essentials_subscription_monthly,
        has_studio_essentials_subscription_yearly,
        has_studio_mobile_subscription_monthly,
        has_studio_mobile_subscription_yearly,
        has_distribution_subscription_monthly,
        has_distribution_subscription_yearly,
        has_distribution_basic_subscription_monthly,
        has_distribution_basic_subscription_yearly,
        has_distribution_pro_subscription_monthly,
        has_distribution_pro_subscription_yearly,
        has_distribution_other_subscription_monthly,
        has_distribution_other_subscription_yearly,
        has_reason_subscription_monthly,
        has_reason_subscription_yearly,
        has_reason_rack_subscription_monthly,
        has_reason_rack_subscription_yearly,
        has_reason_plus_subscription_monthly,
        has_reason_plus_subscription_yearly,
        has_chromatic_subscription_monthly,
        has_chromatic_subscription_yearly,
        has_gen_ai_subscription_monthly,
        has_gen_ai_subscription_yearly,
        has_mastering_subscription_monthly,
        has_mastering_subscription_yearly,
        has_learn_subscription_monthly,
        has_learn_subscription_yearly,
        has_samples_subscription_monthly,
        has_samples_subscription_yearly,
        has_sessions_subscription_monthly,
        has_sessions_subscription_yearly,
        has_storage_subscription_monthly,
        has_storage_subscription_yearly,
        has_synchroarts_subscription_monthly,
        has_synchroarts_subscription_yearly
    ))
    WHERE daily_status IS NOT NULL
      AND daily_status <> ''                        -- drop the inactive cells
)

SELECT
    uau_user_id,
    subscription_date,
    product_stream,
    daily_status,

    -- Parsed dimensions ----------------------------------------------------
    SPLIT_PART(product_stream, '_subscription_', 2)           AS billing_cycle,

    CASE
        WHEN product_stream LIKE 'has_studio_%'        THEN 'studio'
        WHEN product_stream LIKE 'has_distribution_%'  THEN 'distribution'
        WHEN product_stream LIKE 'has_reason_%'  THEN 'reason'
        ELSE REGEXP_SUBSTR(product_stream, '^has_(.*)_subscription_(monthly|yearly)$', 1, 1, 'e', 1)
    END                                                       AS product_family,

    CASE
        -- Studio
        WHEN product_stream IN ('has_studio_subscription_monthly',
                                'has_studio_subscription_yearly')        THEN 'umbrella'
        WHEN product_stream LIKE 'has_studio_pro_%'                      THEN 'pro'
        WHEN product_stream LIKE 'has_studio_standard_%'                 THEN 'standard'
        WHEN product_stream LIKE 'has_studio_essentials_%'               THEN 'essentials'
        WHEN product_stream LIKE 'has_studio_mobile_%'                   THEN 'mobile'
        -- Distribution
        WHEN product_stream IN ('has_distribution_subscription_monthly',
                                'has_distribution_subscription_yearly')  THEN 'umbrella'
        WHEN product_stream LIKE 'has_distribution_basic_%'              THEN 'basic'
        WHEN product_stream LIKE 'has_distribution_pro_%'                THEN 'pro'
        WHEN product_stream LIKE 'has_distribution_other_%'              THEN 'other'
        -- Reason
        WHEN product_stream IN ('has_reason_subscription_monthly',
                                'has_reason_subscription_yearly')        THEN 'umbrella'
        WHEN product_stream LIKE 'has_reason_rack_%'                     THEN 'rack'
        WHEN product_stream LIKE 'has_reason_plus_%'                     THEN 'plus'
        -- Standalone products have no sub-plans
        ELSE 'umbrella'
    END                                                       AS plan_name,

    CASE
        WHEN product_stream IN ('has_studio_subscription_monthly',
                                'has_studio_subscription_yearly',
                                'has_distribution_subscription_monthly',
                                'has_distribution_subscription_yearly',
                                'has_reason_subscription_monthly',
                                'has_reason_subscription_yearly') THEN TRUE
        WHEN product_stream LIKE 'has_studio_%'        THEN FALSE   -- per-plan studio
        WHEN product_stream LIKE 'has_distribution_%'  THEN FALSE   -- per-plan distribution
        WHEN product_stream LIKE 'has_reason_%'  THEN FALSE         -- per-plan reason
        ELSE TRUE                                                   -- standalone product = its own umbrella
    END                                                       AS is_umbrella
FROM unpivoted
;
