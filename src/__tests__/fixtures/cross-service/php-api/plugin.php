<?php

use GuzzleHttp\Client;

register_rest_route('acme/v1', '/health', array('methods' => 'GET'));
register_rest_route('acme/v1', '/items/{id}', array('methods' => array('GET', 'HEAD')));

wp_remote_get('https://python-api/users/42?token=discarded#fragment');
wp_remote_post('https://python-api/users', array('headers' => array('Authorization' => 'discarded')));
wp_remote_request('https://python-api/users/42', array('method' => 'PATCH', 'body' => 'discarded'));

$client = new Client();
$client->get('https://python-api/users/42');
$client->post('https://python-api/users');

$unrelated = new stdClass();
$unrelated->get('https://ignored.invalid/unrelated');

add_action('wp_ajax_acme_tip', 'acme_tip');
add_action('admin_post_acme_tip', 'acme_tip');
add_menu_page('Acme', 'Acme', 'manage_options', 'acme-one', 'acme_tip');
add_menu_page('Acme Two', 'Acme Two', 'manage_options', 'acme-two', 'acme_tip');

function acme_tip(): void {}
