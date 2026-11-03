# CLUVO STAGE 7: DISCOVERY COUNT & ARTIFACT RECONCILIATION

**Component:** Cross-Repository Architecture & Feature Inventory  
**Date:** 2026-11-01  
**Author:** Principal Software Architect & Senior QA Lead  

---

## 1. Objective & Context

During the Stage 7 Phase 1 Product Discovery audit, different documentation artifacts referenced varying counts for mobile screens, routes, and missing feature items (e.g. 19 vs 21 vs 24 screens). 

The objective of this document is to perform a definitive, physical source-code reconciliation across:
1. Physical screen widget classes in `apps/mobile/lib/screens/`.
2. Router definitions in `apps/mobile/lib/app.dart`.
3. Inventory of missing features across functional domains.

---

## 2. Mobile Screen & Route Reconciliation

### 2.1 Physical Files in `apps/mobile/lib/screens/`
The directory contains exactly **22 Dart files**:
- **21 physical Screen classes** (representing user-facing views)
- **1 Shell navigation widget** (`main_shell.dart`, which hosts the bottom navigation bar)

| # | File Name | Screen Class Name | Primary Responsibility |
|---|---|---|---|
| 1 | `login_screen.dart` | `LoginScreen` | Phone number entry & OTP initiation |
| 2 | `otp_screen.dart` | `OtpScreen` | 6-digit SMS verification code entry |
| 3 | `profile_setup_screen.dart` | `ProfileSetupScreen` | First-time profile name, avatar & bio onboarding |
| 4 | `explore_screen.dart` | `ExploreScreen` | Event feed, category filters, and featured events |
| 5 | `search_screen.dart` | `SearchScreen` | Full-text query and city/date event search |
| 6 | `event_details_screen.dart` | `EventDetailsScreen` | Event information, venue, schedule, price, CTA |
| 7 | `booking_screen.dart` | `BookingScreen` | Ticket quantity selection, pricing breakdown |
| 8 | `payment_screen.dart` | `PaymentScreen` | Razorpay gateway checkout trigger & webhook wait |
| 9 | `booking_confirmation_screen.dart` | `BookingConfirmationScreen` | Success banner, booking summary, ticket link |
| 10 | `my_tickets_screen.dart` | `MyTicketsScreen` | List of upcoming and past booked tickets |
| 11 | `ticket_detail_screen.dart` | `TicketDetailScreen` | Dynamic QR code display, cancellation action |
| 12 | `community_details_screen.dart` | `CommunityDetailsScreen` | Community profile, member count, event list |
| 13 | `community_chat_screen.dart` | `CommunityChatScreen` | Real-time member group messaging |
| 14 | `profile_screen.dart` | `ProfileScreen` | User profile overview, settings, logout |
| 15 | `edit_profile_screen.dart` | `EditProfileScreen` | Profile avatar upload, name and bio editing |
| 16 | `manage_tickets_screen.dart` | `ManageTicketsScreen` | Organizer event ticket roster & attendance stats |
| 17 | `scan_qr_screen.dart` | `ScanQrScreen` | Camera viewfinder for scanning attendee ticket QRs |
| 18 | `ticket_validator_screen.dart` | `TicketValidatorScreen` | Check-in verification modal & manual override |
| 19 | `payment_history_screen.dart` | `PaymentHistoryScreen` | Customer ledger of transactions and refunds |
| 20 | `payment_detail_screen.dart` | `PaymentDetailScreen` | Transaction breakdown, UTR, invoice view |
| 21 | `notifications_screen.dart` | `NotificationsScreen` | Push notifications and in-app alert inbox |
| -- | `main_shell.dart` | `MainShell` | *Shell container widget (Hosts BottomNavigationBar)* |

### 2.2 GoRouter Route Declarations in `apps/mobile/lib/app.dart`
The `GoRouter` configuration in `apps/mobile/lib/app.dart` contains exactly **24 `GoRoute` entries**:

1. `/` $\to$ Redirect to `/explore`
2. `/login` $\to$ `LoginScreen`
3. `/phone-login` $\to$ `LoginScreen` (Duplicate route alias)
4. `/otp` $\to$ `OtpScreen`
5. `/profile-setup` $\to$ `ProfileSetupScreen`
6. `/explore` $\to$ `ExploreScreen` (Tab 1)
7. `/search` $\to$ `SearchScreen`
8. `/event/:id` $\to$ `EventDetailsScreen`
9. `/booking/:id` $\to$ `BookingScreen`
10. `/payment` $\to$ `PaymentScreen`
11. `/booking-confirmation/:id` $\to$ `BookingConfirmationScreen`
12. `/my-tickets` $\to$ `MyTicketsScreen` (Tab 2)
13. `/ticket/:id` $\to$ `TicketDetailScreen`
14. `/community/:id` $\to$ `CommunityDetailsScreen`
15. `/chat/:id` $\to$ `CommunityChatScreen`
16. `/profile` $\to$ `ProfileScreen` (Tab 3)
17. `/edit-profile` $\to$ `EditProfileScreen`
18. `/manage-tickets/:id` $\to$ `ManageTicketsScreen`
19. `/scan-qr/:id` $\to$ `ScanQrScreen`
20. `/validate-ticket/:id` $\to$ `TicketValidatorScreen`
21. `/payments` $\to$ `PaymentHistoryScreen`
22. `/payments/:id` $\to$ `PaymentDetailScreen`
23. `/payment-detail/:id` $\to$ `PaymentDetailScreen` (Backward-compatible alias)
24. `/notifications` $\to$ `NotificationsScreen`

### 2.3 Reconciliation of Counts
- **Physical Screen Classes:** **21**
- **Root Shell Widgets:** **1** (`MainShell`)
- **Total Dart Files in `screens/`:** **22**
- **GoRoute Router Entries:** **24** (comprising 21 primary paths + 1 root redirect + 2 route aliases)

*Conclusion:* The previous count discrepancy between "19", "21", and "24" screens was caused by:
- Stating 19 by omitting secondary ticketing screens (`manage_tickets_screen.dart` and `ticket_validator_screen.dart`).
- Stating 21 for the distinct user-facing screen classes.
- Stating 24 for the declared `GoRoute` router endpoints.
**The definitive standard is 21 Screen Classes across 24 Routes.**

---

## 3. Missing Feature Inventory Reconciliation

Across the platform (Mobile, Organizer Web, Admin Web, Database), product discovery identified **5 discrete missing feature items** across 4 functional domains.

### 3.1 Domain Breakdown

| Feature ID | Functional Domain | Target Subsystem | Description & Gap |
|---|---|---|---|
| **MOB-COUP-001** | Coupons & Promotions | Customer Mobile (`apps/mobile`) | Coupon input box and discount calculation widget is missing from `BookingScreen` / `PaymentScreen`. Backend tables exist, but mobile frontend lacks UI. |
| **ORG-COUP-001** | Coupons & Promotions | Organizer Web (`apps/organizer-web`) | Coupon management view (create coupon, discount %, max uses, expiry date) is missing from the organizer dashboard. |
| **MOB-REVW-001** | Reviews & Ratings | Customer Mobile (`apps/mobile`) | Attendee post-event star rating and written review submission screen/dialog is missing. Database has review tables, but mobile app has no entry point. |
| **MOB-WAIT-001** | Waitlist & Queue | Customer Mobile (`apps/mobile`) | Join waitlist button when event capacity is exhausted (`booked_count >= max_capacity`). Backend queue exists, but mobile button is disabled without waitlist option. |
| **ORG-ANLY-001** | Analytics & Insights | Organizer Web (`apps/organizer-web`) | Advanced time-series attendee check-in rate charts and ticket conversion analytics view is missing from organizer reports. |

### 3.2 Reconciliation Status
- Total missing features cataloged: **5**
- Critical security or atomicity defects: **0** (These 5 items are product feature gaps, not security bugs)
- Action: Documented for future sprint planning following Phase 2 security and reliability remediation.

