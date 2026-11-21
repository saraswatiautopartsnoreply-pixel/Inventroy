<?php
/**
 * Plugin Name: Saraswati YMM Fitment Connector
 * Description: Exposes published WooCommerce vehicle fitments stored in the wp_yymm table to Saraswati Inventory.
 * Version: 1.0.0
 * License: GPL-2.0-or-later
 */

defined('ABSPATH') || exit;

add_action('rest_api_init', static function () {
    register_rest_route('saraswati/v1', '/ymm/options', [
        'methods' => WP_REST_Server::READABLE,
        'callback' => 'saraswati_ymm_options',
        'permission_callback' => '__return_true',
        'args' => [
            'make' => ['type' => 'string', 'sanitize_callback' => 'sanitize_text_field'],
            'model' => ['type' => 'string', 'sanitize_callback' => 'sanitize_text_field'],
        ],
    ]);
    register_rest_route('saraswati/v1', '/ymm/products', [
        'methods' => WP_REST_Server::READABLE,
        'callback' => 'saraswati_ymm_products',
        'permission_callback' => '__return_true',
        'args' => [
            'make' => ['required' => true, 'type' => 'string', 'sanitize_callback' => 'sanitize_text_field'],
            'model' => ['required' => true, 'type' => 'string', 'sanitize_callback' => 'sanitize_text_field'],
            'year' => ['required' => true, 'type' => 'integer', 'sanitize_callback' => 'absint'],
            'page' => ['type' => 'integer', 'default' => 1, 'sanitize_callback' => 'absint'],
            'per_page' => ['type' => 'integer', 'default' => 24, 'sanitize_callback' => 'absint'],
        ],
    ]);
});

function saraswati_ymm_table() {
    global $wpdb;
    $table = $wpdb->prefix . 'ymm';
    $exists = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table)));
    if ($exists !== $table) {
        return new WP_Error('saraswati_ymm_table_missing', 'The WordPress YMM table was not found.', ['status' => 503]);
    }
    return $table;
}

function saraswati_ymm_public_product_join() {
    global $wpdb;
    return "INNER JOIN {$wpdb->posts} AS p ON p.ID = y.product_id AND p.post_type = 'product' AND p.post_status = 'publish'";
}

function saraswati_ymm_options(WP_REST_Request $request) {
    global $wpdb;
    $table = saraswati_ymm_table();
    if (is_wp_error($table)) return $table;
    $make = trim((string) $request->get_param('make'));
    $model = trim((string) $request->get_param('model'));
    $join = saraswati_ymm_public_product_join();

    if ($make === '') {
        $values = $wpdb->get_col("SELECT DISTINCT y.make FROM {$table} AS y {$join} WHERE y.make <> '' ORDER BY y.make LIMIT 1000");
        return rest_ensure_response(['makes' => array_values(array_filter(array_map('strval', $values)))]);
    }
    if ($model === '') {
        $values = $wpdb->get_col($wpdb->prepare("SELECT DISTINCT y.model FROM {$table} AS y {$join} WHERE y.make = %s AND y.model <> '' ORDER BY y.model LIMIT 2000", $make));
        return rest_ensure_response(['models' => array_values(array_filter(array_map('strval', $values)))]);
    }

    $ranges = $wpdb->get_results($wpdb->prepare("SELECT DISTINCT y.year_from, y.year_to FROM {$table} AS y {$join} WHERE y.make = %s AND y.model = %s AND y.year_from > 0 AND y.year_to >= y.year_from", $make, $model), ARRAY_A);
    $years = [];
    foreach ($ranges as $range) {
        $from = (int) $range['year_from'];
        $to = min((int) $range['year_to'], $from + 100);
        for ($year = $from; $year <= $to; $year++) $years[$year] = $year;
    }
    ksort($years, SORT_NUMERIC);
    return rest_ensure_response(['years' => array_values($years)]);
}

function saraswati_ymm_products(WP_REST_Request $request) {
    global $wpdb;
    $table = saraswati_ymm_table();
    if (is_wp_error($table)) return $table;
    $make = trim((string) $request->get_param('make'));
    $model = trim((string) $request->get_param('model'));
    $year = (int) $request->get_param('year');
    $page = max(1, (int) $request->get_param('page'));
    $per_page = min(48, max(1, (int) $request->get_param('per_page')));
    if ($make === '' || $model === '' || $year < 1886 || $year > ((int) gmdate('Y') + 2)) {
        return new WP_Error('saraswati_ymm_invalid_vehicle', 'Choose a valid make, model, and year.', ['status' => 400]);
    }

    $join = saraswati_ymm_public_product_join();
    $where = 'y.make = %s AND y.model = %s AND y.year_from <= %d AND y.year_to >= %d';
    $values = [$make, $model, $year, $year];
    $count = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(DISTINCT y.product_id) FROM {$table} AS y {$join} WHERE {$where}", ...$values));
    $offset = ($page - 1) * $per_page;
    $page_values = array_merge($values, [$per_page, $offset]);
    $ids = $wpdb->get_col($wpdb->prepare("SELECT DISTINCT y.product_id FROM {$table} AS y {$join} WHERE {$where} ORDER BY y.product_id LIMIT %d OFFSET %d", ...$page_values));
    return rest_ensure_response([
        'items' => array_map(static fn($id) => ['product_id' => (int) $id], $ids),
        'total' => $count,
        'page' => $page,
        'per_page' => $per_page,
        'pages' => (int) ceil($count / $per_page),
    ]);
}
