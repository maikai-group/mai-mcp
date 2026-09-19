<?php
namespace AcmeShop\Api;

class Points_Rest {
  const REST_NAMESPACE = 'acmeshop/v1';
  public function boot() {
    register_rest_route( self::REST_NAMESPACE, '/points', array() );
    add_action( Foreign::OTHER_HOOK, array( $this, 'boot' ) );
  }
}

class Late_Cron {
  public function boot() {
    wp_schedule_event( time(), 'daily', self::CRON_HOOK );
  }
  const CRON_HOOK = 'acmeshop_points_expiry';
}

class Foreign {
  const OTHER_HOOK = 'acmeshop_cross_class_hook';
}
