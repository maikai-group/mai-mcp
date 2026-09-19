<?php
namespace AcmeShop\Core;

use AcmeShop\Lib\Helper;

require_once __DIR__ . '/helper.php';

class TipService extends BaseService implements Jsonable {

  public function register() {
    add_action( 'init', array( $this, 'boot' ), 10 );
    add_filter( 'woo_fields', array( self::class, 'filter_fields' ) );
    add_action( 'wp_ajax_acmeshop_tip', array( $this, 'ajax_tip' ) );
    register_rest_route( 'acmeshop/v1', '/tip', array( 'callback' => 'ww_free_fn' ) );
    add_shortcode( 'acmeshop_tips', array( $this, 'shortcode' ) );
    wp_schedule_event( time(), 'daily', 'acmeshop_cron' );
    wp_enqueue_script( 'acmeshop-admin', $url, array( 'jquery' ), '1.0', true );
    add_menu_page( 'Tips', 'Tips', 'manage_options', 'acmeshop-tips', array( $this, 'page' ) );
  }

  public function boot() {
    $opts = get_option( 'acmeshop_settings' );
    update_option( 'acmeshop_settings', $opts );
    if ( current_user_can( 'manage_acmeshop' ) ) {
      do_action( 'acmeshop_tip_paid', 1 );
    }
    $type = 'card';
    do_action( "acmeshop_{$type}_settled" );
    Helper::format( 1 );
  }

  public function tables() {
    global $wpdb;
    $wpdb->query( "SELECT * FROM {$wpdb->prefix}acmeshop_tips" );
  }

  public function filter_fields( $f ) { return $f; }
  public function ajax_tip() {}
  public function shortcode() {}
  public function page() {}
}
