# ShopNova v1.0 Requirements

## Authentication
- [ ] **AUTH-01**: User can register with email (valid format, max 254 chars) paired with a password (minimum 8 characters, at least one uppercase letter, at least one digit)
- [ ] **AUTH-02**: User can log in with valid credentials receiving a JWT access token (15-min expiry, RS256) in the response body
  depends_on: [AUTH-01]
- [ ] **AUTH-03**: System returns 401 with structured error {error: {code, message}} when credentials are invalid or token is expired
- [ ] **AUTH-04**: System stores passwords using bcrypt with cost factor 12, never in plaintext or reversible encryption

## Product Catalog
- [ ] **PROD-01**: Admin can create a product with name (required, 1-200 chars), description (Markdown, max 5000 chars), price (positive decimal, 2 places), category (predefined list), up to 10 images (JPEG/PNG/WebP, max 5MB each)
- [ ] **PROD-02**: User can view a paginated product grid (24 per page) showing name, price, primary image thumbnail (200x200), average rating (1-5 stars)
  depends_on: [PROD-01]
- [ ] **PROD-03**: User can filter products by category (checkbox sidebar), price range (min/max slider), availability (in-stock toggle)
  depends_on: [PROD-02]
- [ ] **PROD-04**: User can sort products by price ascending, price descending, newest first, or highest rated
  depends_on: [PROD-02]
- [ ] **PROD-05**: User can view a product detail page showing image gallery, rendered Markdown description, price, stock status, customer reviews
  depends_on: [PROD-01]
- [ ] **PROD-06**: System renders product images as optimized WebP with srcset at 200w, 800w, 1600w breakpoints using next/image with lazy loading
- [ ] **PROD-07**: User can search products by name with debounced input (300ms delay) showing highlighted matching terms in results
  depends_on: [PROD-02]

## Shopping Cart
- [ ] **CART-01**: User can add a product to their cart with quantity selection (1-99), showing a confirmation toast notification
  depends_on: [PROD-05]
- [ ] **CART-02**: User can view their cart page showing line items with product thumbnail, name, unit price, quantity selector, line total
  depends_on: [CART-01]
- [ ] **CART-03**: User can update item quantity or remove items from cart, with subtotal, tax (8.5%), grand total updating in real-time
  depends_on: [CART-02]
- [ ] **CART-04**: User can close the browser then return later with their cart contents preserved via Redis-backed server sessions tied to their account
  depends_on: [CART-01, AUTH-02]
- [ ] **CART-05**: User can view the number of items in their cart via a badge icon in the navigation header that updates without page reload
  depends_on: [CART-01]

## Checkout
- [ ] **CHECK-01**: User can enter shipping address (street, city, state, zip, country) with Zod validation then proceed to payment
  depends_on: [CART-03]
- [ ] **CHECK-02**: User can complete payment via Stripe Checkout receiving an order confirmation page with order number on success
  depends_on: [CHECK-01]

## Traceability

| Requirement | Phase | Plan | Status |
|------------|-------|------|--------|
| AUTH-01 | 10 | 10.1 | Pending |
| AUTH-02 | 10 | 10.1 | Pending |
| AUTH-03 | 10 | 10.1 | Pending |
| AUTH-04 | 10 | 10.1 | Pending |
| PROD-01 | 10 | 10.2 | Pending |
| PROD-02 | 20 | 20.1 | Pending |
| PROD-03 | 20 | 20.2 | Pending |
| PROD-04 | 20 | 20.2 | Pending |
| PROD-05 | 20 | 20.3 | Pending |
| PROD-06 | 20 | 20.3 | Pending |
| PROD-07 | 20 | 20.4 | Pending |
| CART-01 | 30 | 30.1 | Pending |
| CART-02 | 30 | 30.2 | Pending |
| CART-03 | 30 | 30.2 | Pending |
| CART-04 | 30 | 30.3 | Pending |
| CART-05 | 30 | 30.1 | Pending |
| CHECK-01 | 30 | 30.4 | Pending |
| CHECK-02 | 30 | 30.4 | Pending |
