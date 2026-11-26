# Saraswati Inventory System (kaam 2 months ka hai trial m hai yh abhi)

Saraswati Inventory System is a web inventory and sales workspace for automotive spare parts across KG (Kashmiri Gate), SPB (Samaypur Badli), BG (Bangalore), and PB (Palika Bazaar). It includes OE cross-reference, vehicle fitment, rack locations, barcode display, live AJAX product search, sales orders, packing, invoices, sales history, reports, CSV transfer, and optional WooCommerce sync.

Packers can enable web push alerts from the Packing page. An order assigned to them sends a high-priority browser notification with vibration on supported devices. Chrome only offers notifications from secure contexts: production needs HTTPS with a trusted certificate. A local `http://192.168.x.x` address is not secure; `localhost` is allowed only on the same device, so it does not enable phone notifications from a PC. The server needs VAPID keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`); enable notification sounds for the site in the phone's system settings. Packing photos are private to the authorized order team, compressed before upload, and automatically deleted after seven days unless an Admin or Store Manager keeps all photos for that product. MongoDB TTL cleanup removes expired photos; demo-mode photos are held in memory.

## Run a local demo

1. Install Node.js 20.19+ or 22.12+ and run `npm install`.
2. Run `npm run dev:full`.
3. Open `http://localhost:5173` and choose one of the demo roles. Demo password: `stockroom`.

The demo uses in-memory server data. It is for evaluation only: orders, users, stock edits and added racks reset when the API process restarts. Do not expose demo mode to the internet.

## Use MongoDB and Redis locally

1. Copy `.env.example` to `.env` and replace the session secret and bootstrap admin credentials.
2. Start the local services with `docker compose up -d`.
3. Run `npm run dev:full` and sign in with the bootstrap admin email and password.
4. Optionally run `npm run seed:demo` to add example products. Seeding adds missing SKUs and does not overwrite existing stock.

The local MongoDB Compose service is a single-node replica set because order acceptance and packing use MongoDB transactions. Redis caches repeated searches for 15 seconds by default. If Redis is unavailable, product search continues without the cache.

## Roles and workflow

- **Admin** manages users and roles, products, orders, reports, import/export, and WooCommerce.
- **Store Manager** manages products and stock, creates sales orders, and can supervise order packing.
- **Packer** accounts see only Orders and Packing. They can view orders assigned to their account and warehouse, then advance them through packing and dispatch.

New users can register as a Packer or Store Manager with their name, phone, email, password, and warehouse. Accounts remain inactive until an Admin approves them. Store Managers cannot approve users. Packers see only Orders and Packing; the API returns only orders assigned to them at their warehouse. When a manager or admin creates a sale, the packer list is limited to approved Packers at the selected warehouse, and the API validates the warehouse match before reserving stock.

Sales orders check available stock when created. Product setup has one selling price and a **Price includes 18% GST** checkbox. When checked, the saved price is the final customer price (for example ₹1,800 remains ₹1,800, with GST extracted from it); when unchecked, 18% GST is added at sale (₹1,800 becomes ₹2,124). The server calculates GST from the stored product setting and records the price treatment on each order line. From inventory, a manager can open **Sell** on a part, enter quantity/customer/payment, and assign an approved packer. Assignment reserves the stock and records rack allocations in the same MongoDB transaction. The assigned packer can start packing, then mark the order packed to consume reserved stock. Later statuses track shipment and completion. Invoices can be printed or saved as PDF from the browser.

Sales and completed packing actions are recorded as structured activity events with the actor, order, warehouse, customer, product, quantity, unit price, line total, and event time. Managers can review sales in the paginated **Sales history** page or review sales, packing, and team sessions in **Activity**. Login sessions update every minute; an explicit logout is recorded, while a session with no heartbeat for five minutes is marked as a connection loss. MongoDB keeps activity and session records for 210 days (at least six months) using TTL indexes. The demo server keeps these records in memory and clears them on restart; production history requires MongoDB.

## Product CSV

CSV import accepts a header row containing `sku`, `name`, and `brand`. Optional columns are `category`, `oe`, `barcode`, `price`, `priceIncludesGst` (`true`, `yes`, or `1` means the entered price includes GST), `cost`, `reorderPoint`, `warehouse`, `rack`, `qty`, `vehicleMake`, `vehicleModel`, `yearFrom`, `yearTo`, and `engine`; exported files also include a `fitments` JSON column to preserve multiple vehicle matches. Separate multiple OE numbers with `|` or `;`. Repeat the SKU on multiple rows to put stock in multiple racks. Import processes up to 5,000 product rows per request; the export supplies a matching template.

## WooCommerce

Set `WOOCOMMERCE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, and `WOOCOMMERCE_CONSUMER_SECRET` in the API server environment. Use a WooCommerce REST API key with **Read** permissions for the current view-only integration; use HTTPS, and never put the keys in the frontend, chat, or a commit. The product browser displays images and YMM information exposed through WooCommerce product attributes or matching metadata. Product mapping uses SKU. Catalog and processing orders can be imported into Saraswati Inventory; imported orders are deduplicated by WooCommerce order ID.

## Razorpay (bas ab or update nahi)

set "Razorpay_SECRET_key" and "razorpay_consumer_key" in the API server environment. and a refresh button to check payment status In Razorpay, set the webhook URL to https://your-domain/api/webhooks/razorpay, use the same secret as RAZORPAY_WEBHOOK_SECRET in the server .env, and subscribe to payment_link.paid, payment_link.partially_paid, payment_link.cancelled, payment_link.expired, and payment.failed.

## Production deployment and safe updates

The included `render.yaml` deploys the React app and API as one HTTPS web service in Singapore, with a private Redis-compatible cache and a `/api/health` readiness check. It expects a MongoDB Atlas replica-set URI from the Render secret prompt; it does not create a MongoDB cluster or change an existing Atlas database. Choose the Atlas cluster in the same region as the app where possible. Render Key Value and web compute are billable services; review current prices before creating the Blueprint.

For a temporary no-cost pilot, use `render-free.yaml` as the Render Blueprint file. It creates only a free web service and asks for `REDIS_URL` separately, so you can use an external Redis provider. Free hosting can sleep or restart and is not intended for dependable daily company operations. Keep MongoDB as the only source of inventory data, back it up manually, and migrate to paid hosting with backups before relying on the system for sales.

1. Create a dedicated production Atlas database named `saraswati_inventory_prod` and a database user scoped only to that database. Do not point production at a personal or staging database. Enable Atlas backups and confirm that a restore is available before importing company inventory.
2. In Atlas Network Access, allow only the web service's current outbound IPs (or its reserved static egress IPs). Do not use `0.0.0.0/0`. Keep MongoDB and Redis connection values in the hosting secret manager, never in GitHub files.
3. Connect the GitHub repository to Render and create a Blueprint from `render.yaml`. Enter the Atlas URI, bootstrap admin email and password, and stable VAPID keys when prompted. The initial admin is created only if that email does not already exist.
4. Add a custom domain in Render if desired. HTTPS is managed by Render; packer push notifications require this secure origin.
5. Updates go through a pull request to `main`. GitHub Actions runs lint and a production build. Render is configured to deploy only after GitHub checks pass. Keep the Atlas database separate from deployments; deployments build files and restart the service, they do not reseed or replace inventory records.

Use Atlas snapshots before the first inventory import and before database schema changes. Do not run demo seeding in production. Restore a snapshot to a separate database first and validate it before any production restore. The app does not run destructive collection drops, but application updates can still change data through explicit API operations, so maintain backups and keep at least one tested restore point.

The local demo remains in-memory and is blocked from bulk product imports. Production requires persistent MongoDB, Redis-compatible cache, a 32-byte session secret, bootstrap admin credentials, and VAPID keys. The included CI checks build and lint the app; they do not yet run an automated integration suite against a production-like database.

This repository provides the working inventory and order foundation, but production deployment still needs your infrastructure accounts, company identity/tax invoice requirements, and WooCommerce keys. It does not yet include purchase receiving, vendor purchasing, inter-warehouse transfer approvals, refunds/returns, or GST e-invoice integration.
