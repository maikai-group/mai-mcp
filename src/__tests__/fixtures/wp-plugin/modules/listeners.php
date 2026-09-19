<?php

add_action( 'acmeshop_tip_paid', array( Cart_Recovery::class, 'notify' ) );
add_action( 'acmeshop_tip_paid', 'ww_free_fn' );
add_action( 'acmeshop_tip_paid', function ( $id ) { return $id; } );
add_action( 'acmeshop_tip_paid', $dynamic_callback );
add_action( 'acmeshop_tip_paid', array( 'Dup', 'go' ) );
add_action( 'acmeshop_solo', array( Solo::class, 'handle' ) );
