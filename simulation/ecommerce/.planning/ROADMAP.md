# ShopNova v1.0 Roadmap

### Phase 10: Foundation
Goal: User authentication + admin product creation. The data models and auth system that everything else depends on.
**Requirements:** [AUTH-01, AUTH-02, AUTH-03, AUTH-04, PROD-01]
**Plans:** 2 plans

- [ ] 10-01-PLAN — User model + registration + login + JWT
- [ ] 10-02-PLAN — Product model + admin creation endpoint + image upload

### Phase 20: Product Catalog
Goal: Public product browsing — grid view, filtering, sorting, search, detail pages.
**Requirements:** [PROD-02, PROD-03, PROD-04, PROD-05, PROD-06, PROD-07]
**Plans:** 4 plans

- [ ] 20-01-PLAN — Product grid page with pagination
- [ ] 20-02-PLAN — Category filter + price range + availability toggle + sorting
- [ ] 20-03-PLAN — Product detail page with image gallery + Markdown rendering
- [ ] 20-04-PLAN — Product search with debounced input + highlighted results

### Phase 30: Cart & Checkout
Goal: Shopping cart with persistence, checkout flow with Stripe payments.
**Requirements:** [CART-01, CART-02, CART-03, CART-04, CART-05, CHECK-01, CHECK-02]
**Plans:** 4 plans

- [ ] 30-01-PLAN — Add to cart + toast notification
- [ ] 30-02-PLAN — Cart page with line items + quantity management + totals
- [ ] 30-03-PLAN — Redis-backed cart persistence tied to user session
- [ ] 30-04-PLAN — Checkout flow: shipping address + Stripe payment + confirmation
