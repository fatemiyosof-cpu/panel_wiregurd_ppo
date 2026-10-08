# ARcodm Panel + Subscription

Single Render service for the ARcodm panel and subscription API.

- `/` -> AR.html
- `/api/subscriptions` -> subscription management API
- `/sub/:id` -> plain-text subscription feed
- `/health` -> health check

Requires PostgreSQL through `DATABASE_URL`.
No real VPN/WireGuard server or peer provisioning is performed.
