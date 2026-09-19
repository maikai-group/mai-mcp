<?php
namespace AcmeShop\Modules;

use AcmeShop\Lib\Helper as Aliased;

class Aliaser {
  public function hook_it() {
    \add_action( 'acmeshop_aliased', array( Aliased::class, "format" ) );
    add_submenu_page( 'acmeshop-tips', __( 'Sub', 'acme-shop' ), __( 'Sub', 'acme-shop' ), 'manage_options', 'acmeshop-sub', array( $this, "render" ) );
    wp_enqueue_script( "acmeshop-alias-js", $u, array( "jquery" ), '1.0', true );
    $logger = new Logger();
    $logger->query( "SELECT * FROM {$wpdb->prefix}not_a_table" );
    add_action( '', array( $this, 'render' ) );
    add_action( 'acmeshop_str_method', 'AcmeShop\\Lib\\Helper::format' );
    add_action( 'acmeshop_arr_string', array( 'AcmeShop\\Lib\\Helper', 'format' ) );
    $role = get_role( 'administrator' );
    $role->add_cap( 'manage_acmeshop_delivery' );
  }
  public function render() {}
}
