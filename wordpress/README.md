# Saraswati YMM connector

The Car Check screen reads make/model/year fitment rows from the WordPress table `{prefix}ymm` (for example, `wp_yymm`) and displays matching published WooCommerce products.

## Install

1. Copy `saraswati-ymm-rest.php` into `wp-content/plugins/saraswati-ymm-rest/saraswati-ymm-rest.php` on the WordPress site.
2. Activate **Saraswati YMM Fitment Connector** in WordPress Admin → Plugins.
3. Verify that `https://YOUR-STORE/wp-json/saraswati/v1/ymm/options` returns a JSON object with a `makes` list.
4. Reload Saraswati Inventory and open **Car Check** under WooCommerce.

The connector only returns fitment data associated with published `product` posts. Its routes are public because they expose compatibility and published product IDs only; inventory-server authentication and WooCommerce REST credentials are still required to retrieve full catalog details and images.

## Recommended database index

For a large fitment table, add an index through phpMyAdmin or a database migration after checking that an equivalent index does not already exist:

```sql
ALTER TABLE `wp_yymm` ADD INDEX `idx_ymm_make_model_year_product` (`make`(100), `model`(150), `year_from`, `year_to`, `product_id`);
```

Use the actual WordPress table prefix in place of `wp_`. Back up the database before changing indexes.
