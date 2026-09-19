<div class="acmeshop-tip">
  <?php
  namespace AcmeShop\Views;
  add_action( 'acmeshop_view_rendered', 'ww_free_fn' );
  ?>
  <span><?php echo esc_html( $amount ); ?></span>
</div>
