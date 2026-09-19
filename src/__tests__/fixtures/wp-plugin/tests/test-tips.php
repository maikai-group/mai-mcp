<?php
namespace AcmeShop\Tests;

class TipServiceTest {
  public function test_boot() {}
  public function register_probe() {
    register_rest_route( 'acmeshop/v1', '/test-probe', array() );
    wp_schedule_event( time(), 'daily', 'acmeshop_test_cron' );
  }
}
