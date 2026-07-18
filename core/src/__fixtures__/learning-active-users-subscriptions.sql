CREATE OR REPLACE TABLE view_learning_active_users_subscriptions AS
WITH   weekly_users_active_subscription AS
       (SELECT DATE_TRUNC(WEEK, TO_DATE(day_plan_active)) AS active_week,
               user_email,
               REPLACE(ARRAY_AGG(product_name) WITHIN GROUP (ORDER BY IFF(product_name = 'LANDR Studio', 0, 99))[0], '"') AS product_name,
               COUNT(*) AS total_subscriptions
          FROM view_stripe_daily_active_subscriptions
         GROUP BY 1, 2
       ),
       learning_mau_subscription AS
       (SELECT lau.active_week,
               lau.user_active,
               lau.course_title,
               lau.active_time_in_minutes,
               lau.free_sections_active,
               lau.total_sections_active,
               CASE 
                 WHEN uas.product_name IS NULL AND lau.free_sections_active = lau.total_sections_active THEN 'Free Previews'
                 ELSE uas.product_name
               END AS subscription       
          FROM view_learning_active_users AS lau
          LEFT JOIN weekly_users_active_subscription AS uas
            ON LOWER(uas.user_email) = LOWER(lau.user_active)
           AND uas.active_week = lau.active_week
       )
SELECT active_week,
       user_active,
       course_title,
       active_time_in_minutes,
       free_sections_active,
       total_sections_active,
       IFF(subscription LIKE 'LANDR Studio%' OR subscription = 'Courses - Pro', subscription, NULL) AS subscription
  FROM learning_mau_subscription 
;
