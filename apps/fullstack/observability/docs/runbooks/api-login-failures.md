# Rejected logins above 20 per minute

1. In Grafana, break down `auth_login_attempts_total` by `outcome`. `invalid_credentials` is a guessing attack or a wrong client secret; `blocked` is unconfirmed or reset-required users.
2. Find the lines: `{service_name="view-show-api"} | json | event = "auth.login.failed"`. They carry the `reason` and the `request_id`, never the typed username.
3. Check `http_requests_total{status_code="429"}` on `/auth/login`: the dedicated limiter should already be rejecting the source.
4. When it is an attack, lower `AUTH_LOGIN_RATE_LIMIT_PER_MINUTE` and review the Cognito user pool, not the API.
