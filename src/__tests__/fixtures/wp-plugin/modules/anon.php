<?php
namespace AcmeShop\Anon;

class Wrapper {
  public function register() {
    add_action( 'acmeshop_anon_evt', array( $this, 'missing_handler' ) );
    $x = new class {
      const K = 'acmeshop_should_not_leak';
      public function missing_handler() {}
    };
  }
  public function boot() {
    wp_schedule_event( time(), 'daily', self::K );
  }
}
