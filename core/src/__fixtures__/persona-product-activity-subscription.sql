CREATE OR REPLACE TABLE view_uau_monthly_user_persona_product_activity_subscription AS
WITH   month_list AS
       (SELECT DISTINCT calendar_month_date AS event_month
          FROM dim_uau_dates AS dud
         WHERE dud.calendar_month_date >= TO_DATE('2025-01-01')
           AND dud.calendar_month_date < DATE_TRUNC(MONTH, CURRENT_DATE())
       ),
       users_by_month AS
       (SELECT ml.event_month,
               dud.uau_user_id,
               dud.landr_user_id,
               dud.reason_user_id
          FROM month_list AS ml
          CROSS JOIN dim_uau_users AS dud
       ),
       users_personas AS
       (SELECT ubm.event_month,
               ubm.uau_user_id,
               ubm.landr_user_id,
               ubm.reason_user_id,
               IFF(p1.uau_user_id IS NOT NULL, 1, 0) AS is_persona_1,
               IFF(p2.uau_user_id IS NOT NULL, 1, 0) AS is_persona_2,
               IFF(p3.uau_user_id IS NOT NULL, 1, 0) AS is_persona_3,
               IFF(p4.uau_user_id IS NOT NULL, 1, 0) AS is_persona_4,
               IFF(p5.uau_user_id IS NOT NULL, 1, 0) AS is_persona_5
          FROM users_by_month AS ubm
          LEFT JOIN view_uau_persona_1_definition AS p1
            ON p1.uau_user_id = ubm.uau_user_id 
           AND p1.event_month = ubm.event_month 
          LEFT JOIN view_uau_persona_2_definition AS p2
            ON p2.uau_user_id = ubm.uau_user_id 
           AND p2.event_month = ubm.event_month
          LEFT JOIN view_uau_persona_3_definition AS p3
            ON p3.uau_user_id = ubm.uau_user_id 
           AND p3.event_month = ubm.event_month
          LEFT JOIN view_uau_persona_4_definition AS p4
            ON p4.uau_user_id = ubm.uau_user_id 
           AND p4.event_month = ubm.event_month
          LEFT JOIN view_uau_persona_5_definition AS p5
            ON p5.uau_user_id = ubm.uau_user_id 
           AND p5.event_month = ubm.event_month
         WHERE NULLIF(ubm.uau_user_id, '') IS NOT NULL
       ),
       persona_users AS
       (SELECT event_month,
               uau_user_id,
               landr_user_id,
               reason_user_id,
               is_persona_1,
               is_persona_2,
               is_persona_3,
               is_persona_4,
               is_persona_5
          FROM users_personas
         WHERE is_persona_1 + is_persona_2 + is_persona_3 + is_persona_4 + is_persona_5 > 0
       ),
       enriched_persona AS
       (SELECT pu.event_month,
               pu.uau_user_id,
               pu.landr_user_id,
               pu.reason_user_id,
               pu.is_persona_1,
               pu.is_persona_2,
               pu.is_persona_3,
               pu.is_persona_4,
               pu.is_persona_5,
               s.has_reason_plus_subscription_monthly AS _has_reason_plus_subscription_monthly,
               s.has_reason_rack_subscription_monthly AS _has_reason_rack_subscription_monthly,
               s.has_reason_plus_subscription_yearly AS _has_reason_plus_subscription_yearly,
               s.has_reason_rack_subscription_yearly AS _has_reason_rack_subscription_yearly,
               s.has_chromatic_subscription_monthly AS _has_chromatic_subscription_monthly,
               s.has_chromatic_subscription_yearly AS _has_chromatic_subscription_yearly,
               s.has_distribution_subscription_monthly AS _has_distribution_subscription_monthly,
               s.has_distribution_subscription_yearly AS _has_distribution_subscription_yearly,
               s.has_distribution_basic_subscription_monthly AS _has_distribution_basic_subscription_monthly,
               s.has_distribution_basic_subscription_yearly AS _has_distribution_basic_subscription_yearly,
               s.has_distribution_pro_subscription_monthly AS _has_distribution_pro_subscription_monthly,
               s.has_distribution_pro_subscription_yearly AS _has_distribution_pro_subscription_yearly,
               s.has_distribution_other_subscription_monthly AS _has_distribution_other_subscription_monthly,
               s.has_distribution_other_subscription_yearly AS _has_distribution_other_subscription_yearly,
               s.has_gen_ai_subscription_monthly AS _has_gen_ai_subscription_monthly,
               s.has_gen_ai_subscription_yearly AS _has_gen_ai_subscription_yearly,
               s.has_learn_subscription_monthly AS _has_learn_subscription_monthly,
               s.has_learn_subscription_yearly AS _has_learn_subscription_yearly,
               s.has_mastering_subscription_monthly AS _has_mastering_subscription_monthly,
               s.has_mastering_subscription_yearly AS _has_mastering_subscription_yearly,
               s.has_samples_subscription_monthly AS _has_samples_subscription_monthly,
               s.has_samples_subscription_yearly AS _has_samples_subscription_yearly,
               s.has_sessions_subscription_monthly AS _has_sessions_subscription_monthly,
               s.has_sessions_subscription_yearly AS _has_sessions_subscription_yearly,
               s.has_storage_subscription_monthly AS _has_storage_subscription_monthly,
               s.has_storage_subscription_yearly AS _has_storage_subscription_yearly,
               s.has_studio_subscription_monthly AS _has_studio_subscription_monthly,
               s.has_studio_subscription_yearly AS _has_studio_subscription_yearly,
               s.has_studio_essentials_subscription_monthly AS _has_studio_essentials_subscription_monthly,
               s.has_studio_essentials_subscription_yearly AS _has_studio_essentials_subscription_yearly,
               s.has_studio_mobile_subscription_monthly AS _has_studio_mobile_subscription_monthly,
               s.has_studio_mobile_subscription_yearly AS _has_studio_mobile_subscription_yearly,
               s.has_studio_pro_subscription_monthly AS _has_studio_pro_subscription_monthly,
               s.has_studio_pro_subscription_yearly AS _has_studio_pro_subscription_yearly,
               s.has_studio_standard_subscription_monthly AS _has_studio_standard_subscription_monthly,
               s.has_studio_standard_subscription_yearly AS _has_studio_standard_subscription_yearly,
               s.has_synchroarts_subscription_monthly AS _has_synchroarts_subscription_monthly,
               s.has_synchroarts_subscription_yearly AS _has_synchroarts_subscription_yearly,
               NVL(u.is_collaboration_used, 0) AS is_collaboration_used,
               NVL(u.is_distribution_used, 0) AS is_distribution_used,
               NVL(u.is_learn_used, 0) AS is_learn_used,
               NVL(u.is_mastering_used, 0) AS is_mastering_used,
               NVL(u.is_plugins_used, 0) AS is_plugins_used,
               NVL(u.is_reason_plus_used, 0) AS is_reason_plus_used,
               NVL(u.is_reason_rack_used, 0) AS is_reason_rack_used,
               NVL(u.is_rehance_used, 0) AS is_rehance_used,
               NVL(u.is_samples_used, 0) AS is_samples_used,
               NVL(u.is_stems_used, 0) AS is_stems_used,
               NVL(u.is_vocals_used, 0) AS is_vocals_used,
               NVL(rpu.alc_revenue_cad, 0) AS alc_revenues,
               NVL(rpu.monthly_subscription_revenue_cad, 0) AS monthly_subscription_revenues,
               NVL(rpu.yearly_subscription_revenue_cad, 0) AS yearly_subscription_revenues
          FROM persona_users AS pu
          LEFT JOIN view_uau_monthly_products_subscribed_by_user AS s
            ON s.uau_user_id = pu.uau_user_id 
           AND s.subscription_month = pu.event_month 
          LEFT JOIN view_uau_monthly_products_used_by_user AS u
            ON u.uau_user_id = pu.uau_user_id 
           AND u.event_month = pu.event_month 
          LEFT JOIN view_uau_monthly_revenues_per_user AS rpu
            ON rpu.calendar_month_date = pu.event_month
           AND rpu.uau_user_id = pu.uau_user_id
       )
SELECT event_month,
       uau_user_id,
       landr_user_id,
       reason_user_id,
       is_persona_1,
       is_persona_2,
       is_persona_3,
       is_persona_4,
       is_persona_5,
       NVL(NULLIF(_has_reason_plus_subscription_monthly, ''), 'NULL') AS has_reason_plus_subscription_monthly,
       NVL(NULLIF(_has_reason_rack_subscription_monthly, ''), 'NULL') AS has_reason_rack_subscription_monthly,
       NVL(NULLIF(_has_reason_plus_subscription_yearly, ''), 'NULL') AS has_reason_plus_subscription_yearly,
       NVL(NULLIF(_has_reason_rack_subscription_yearly, ''), 'NULL') AS has_reason_rack_subscription_yearly,       
       NVL(NULLIF(_has_studio_subscription_monthly, ''), 'NULL') AS has_studio_subscription_monthly,
       NVL(NULLIF(_has_studio_subscription_yearly, ''), 'NULL') AS has_studio_subscription_yearly,
       NVL(NULLIF(_has_studio_pro_subscription_monthly, ''), 'NULL') AS has_studio_pro_subscription_monthly,
       NVL(NULLIF(_has_studio_pro_subscription_yearly, ''), 'NULL') AS has_studio_pro_subscription_yearly,
       NVL(NULLIF(_has_studio_standard_subscription_monthly, ''), 'NULL') AS has_studio_standard_subscription_monthly,
       NVL(NULLIF(_has_studio_standard_subscription_yearly, ''), 'NULL') AS has_studio_standard_subscription_yearly,
       NVL(NULLIF(_has_studio_essentials_subscription_monthly, ''), 'NULL') AS has_studio_essentials_subscription_monthly,
       NVL(NULLIF(_has_studio_essentials_subscription_yearly, ''), 'NULL') AS has_studio_essentials_subscription_yearly,
       NVL(NULLIF(_has_studio_mobile_subscription_monthly, ''), 'NULL') AS has_studio_mobile_subscription_monthly,
       NVL(NULLIF(_has_studio_mobile_subscription_yearly, ''), 'NULL') AS has_studio_mobile_subscription_yearly,
       NVL(NULLIF(_has_chromatic_subscription_monthly, ''), 'NULL') AS has_chromatic_subscription_monthly,
       NVL(NULLIF(_has_chromatic_subscription_yearly, ''), 'NULL') AS has_chromatic_subscription_yearly,
       NVL(NULLIF(_has_distribution_subscription_monthly, ''), 'NULL') AS has_distribution_subscription_monthly,
       NVL(NULLIF(_has_distribution_subscription_yearly, ''), 'NULL') AS has_distribution_subscription_yearly,
       NVL(NULLIF(_has_distribution_basic_subscription_monthly, ''), 'NULL') AS has_distribution_basic_subscription_monthly,
       NVL(NULLIF(_has_distribution_basic_subscription_yearly, ''), 'NULL') AS has_distribution_basic_subscription_yearly,
       NVL(NULLIF(_has_distribution_pro_subscription_monthly, ''), 'NULL') AS has_distribution_pro_subscription_monthly,
       NVL(NULLIF(_has_distribution_pro_subscription_yearly, ''), 'NULL') AS has_distribution_pro_subscription_yearly,
       NVL(NULLIF(_has_distribution_other_subscription_monthly, ''), 'NULL') AS has_distribution_other_subscription_monthly,
       NVL(NULLIF(_has_distribution_other_subscription_yearly, ''), 'NULL') AS has_distribution_other_subscription_yearly,
       NVL(NULLIF(_has_gen_ai_subscription_monthly, ''), 'NULL') AS has_gen_ai_subscription_monthly,
       NVL(NULLIF(_has_gen_ai_subscription_yearly, ''), 'NULL') AS has_gen_ai_subscription_yearly,
       NVL(NULLIF(_has_mastering_subscription_monthly, ''), 'NULL') AS has_mastering_subscription_monthly,
       NVL(NULLIF(_has_mastering_subscription_yearly, ''), 'NULL') AS has_mastering_subscription_yearly,
       NVL(NULLIF(_has_learn_subscription_monthly, ''), 'NULL') AS has_learn_subscription_monthly,
       NVL(NULLIF(_has_learn_subscription_yearly, ''), 'NULL') AS has_learn_subscription_yearly,
       NVL(NULLIF(_has_samples_subscription_monthly, ''), 'NULL') AS has_samples_subscription_monthly,
       NVL(NULLIF(_has_samples_subscription_yearly, ''), 'NULL') AS has_samples_subscription_yearly,
       NVL(NULLIF(_has_sessions_subscription_monthly, ''), 'NULL') AS has_sessions_subscription_monthly,
       NVL(NULLIF(_has_sessions_subscription_yearly, ''), 'NULL') AS has_sessions_subscription_yearly,
       NVL(NULLIF(_has_storage_subscription_monthly, ''), 'NULL') AS has_storage_subscription_monthly,
       NVL(NULLIF(_has_storage_subscription_yearly, ''), 'NULL') AS has_storage_subscription_yearly,
       NVL(NULLIF(_has_synchroarts_subscription_monthly, ''), 'NULL') AS has_synchroarts_subscription_monthly,
       NVL(NULLIF(_has_synchroarts_subscription_yearly, ''), 'NULL') AS has_synchroarts_subscription_yearly,
       is_collaboration_used,
       is_distribution_used,
       is_learn_used,
       is_mastering_used,
       is_plugins_used,
       is_reason_plus_used,
       is_reason_rack_used,
       is_rehance_used,
       is_samples_used,
       is_stems_used,
       is_vocals_used,
       IFF(has_reason_plus_subscription_monthly != 'NULL', 1, 0) + 
         IFF(has_reason_rack_subscription_monthly != 'NULL', 1, 0) +
         IFF(has_chromatic_subscription_monthly != 'NULL', 1, 0) + 
         IFF(has_distribution_subscription_monthly != 'NULL', 1, 0) + 
         IFF(has_gen_ai_subscription_monthly != 'NULL', 1, 0) + 
         IFF(has_learn_subscription_monthly != 'NULL', 1, 0) +
         IFF(has_mastering_subscription_monthly != 'NULL', 1, 0) +
         IFF(has_samples_subscription_monthly != 'NULL', 1, 0) + 
         IFF(has_sessions_subscription_monthly != 'NULL', 1, 0) + 
         IFF(has_storage_subscription_monthly != 'NULL', 1, 0) +
         IFF(has_studio_subscription_monthly != 'NULL', 1, 0) + 
         IFF(has_synchroarts_subscription_monthly != 'NULL', 1, 0) +
         --
         IFF(has_reason_plus_subscription_yearly != 'NULL', 1, 0) + 
         IFF(has_reason_rack_subscription_yearly != 'NULL', 1, 0) +
         IFF(has_chromatic_subscription_yearly != 'NULL', 1, 0) + 
         IFF(has_distribution_subscription_yearly != 'NULL', 1, 0) + 
         IFF(has_gen_ai_subscription_yearly != 'NULL', 1, 0) + 
         IFF(has_learn_subscription_yearly != 'NULL', 1, 0) +
         IFF(has_mastering_subscription_yearly != 'NULL', 1, 0) +
         IFF(has_samples_subscription_yearly != 'NULL', 1, 0) + 
         IFF(has_sessions_subscription_yearly != 'NULL', 1, 0) + 
         IFF(has_storage_subscription_yearly != 'NULL', 1, 0) +
         IFF(has_studio_subscription_yearly != 'NULL', 1, 0) + 
         IFF(has_synchroarts_subscription_yearly != 'NULL', 1, 0)
       AS total_products_subscribed,
       is_collaboration_used + is_distribution_used + is_learn_used + is_mastering_used +
         is_plugins_used + is_reason_plus_used + is_reason_rack_used + is_rehance_used +
         is_samples_used + is_stems_used + is_vocals_used
       AS total_products_used,
       alc_revenues,
       monthly_subscription_revenues,
       yearly_subscription_revenues,
       alc_revenues + monthly_subscription_revenues + yearly_subscription_revenues AS total_revenues
  FROM enriched_persona
;
