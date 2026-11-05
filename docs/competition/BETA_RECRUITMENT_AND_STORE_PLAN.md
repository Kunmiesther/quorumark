# Founding 200 community beta and store plan

This is a private community distribution package, not a public recruitment
campaign. Send it only after the official rules and both install links work.
The public may use the ordinary TurtleBot app without joining the competition.

## Distribution

Use Apple TestFlight external testing and Google Play closed testing.

- TestFlight permits up to 10,000 external testers. After the first external
  build passes beta review, invite the 200 community members by email or share
  an access-controlled link only inside the approved community.
- A TestFlight build can be tested for 90 days, covering the six-week event.
- Google Play internal testing caps at 100 testers, so use a closed-test track.
- Personal Google developer accounts created after November 13, 2023 must keep
  at least 12 closed testers continuously opted in for 14 days before applying
  for production access.

Community administrators nominate 200 members and a small alternate list.
Competition access is granted separately from ordinary TurtleBot access.

## Enrollment funnel

1. Community administrators nominate members and collect email, U.S. state,
   platform, age confirmation, and consent to beta communications.
2. Mark members Invited, Activated, Alternate, Declined, or Removed.
3. Send invited members only their platform-specific install link.
4. Require installation, onboarding, rules acceptance, and paper reset before
   the opening bell.
5. Return unclaimed seats to community alternates before competition start.
6. Collect structured weekly feedback without changing strategy parameters.

## Apple TestFlight checklist

1. Create the App Store Connect record for `com.onixus.turtlebot`.
2. Upload a signed beta through Xcode, Xcode Cloud, or approved CI.
3. Add the beta description, features to test, feedback email, privacy URL,
   export-compliance answers, and reviewer credentials.
4. Create an internal group and complete smoke testing.
5. Create `Founding 200 — Paper Competition` as an external group.
6. Add the build and submit the first external build for TestFlight review.
7. After approval, distribute by invited email or a private community link with
   a 200-tester limit and compatible device and OS criteria.

Suggested beta description:

> TurtleBot is a non-custodial trading companion. This beta is limited to a
> six-week paper-trading product test using simulated funds. No deposits,
> withdrawals, or live orders are available. Test onboarding, Onyx guidance,
> AI Council explanations, paper automation, risk controls, notifications,
> leaderboard accuracy, account deletion, and offline recovery.

## Google Play checklist

1. Create the app with package ID `com.onixus.turtlebot`.
2. Complete App access, Financial features, Data safety, content rating,
   privacy, deletion, target-audience, and advertising declarations.
3. Upload a signed Android App Bundle to internal testing and smoke-test it.
4. Promote the approved build to a closed track named `Founding 200`.
5. Add the tester Google Group/list and publish the closed-test opt-in link.
6. Verify installation from a non-owner Android account.
7. If applicable, keep at least 12 testers opted in continuously for 14 days.

## Private community announcement

### Main announcement

> **TurtleBot Community: Join the Founding 200**
>
> Our TurtleBot community is inviting 200 approved members to a private,
> six-week paper-trading competition. Everyone starts with $2,000 in simulated
> funds and tests the same risk system, Onyx guidance, and AI Council workflow.
>
> This is paper trading only: no deposit, no entry fee, and no live orders.
> Three winners share $500: $300 for first, $150 for second, and $50 for third.
> Rankings reward return and disciplined drawdown control—not
> reckless leverage. Participants help verify mobile reliability,
> explanations, risk controls, and the leaderboard before public launch.
>
> Invited members must be 18+, live in an eligible U.S. jurisdiction, accept
> the official rules, and use a compatible iPhone or Android device. Claim your
> community invitation: [COMMUNITY_INVITE_URL]
>
> Paper and backtested performance does not predict live results. Apple and
> Google are not sponsors or administrators of this competition.

### Short post

> Community members: 200 seats, six weeks, and $2,000 in simulated funds.
> TurtleBot's private Founding 200 competition is coming to iPhone and Android.
> No deposit, no entry fee, and no live trading. Three prizes: $300, $150, and
> $50. Invitation: [COMMUNITY_INVITE_URL] Rules: [RULES_URL]

### Accepted tester email

Subject: Your TurtleBot Founding 200 beta seat

> Your seat is reserved until [CLAIM_DEADLINE]. Install TurtleBot, finish
> onboarding, and accept the rules before the opening bell. Your paper account
> will reset to $2,000 automatically.
>
> iPhone: [TESTFLIGHT_URL]
> Android: [PLAY_CLOSED_TEST_URL]
> Rules: [RULES_URL]
> Support: [VERIFIED_SUPPORT_EMAIL]

## Targets

| Stage | Target |
| --- | ---: |
| Invited community members and alternates | 220 |
| Activated seats | 200 |
| Week-one active testers | 170 |
| Six-week completers | 140 |
| Crash-free sessions | at least 99.5% |
| Successful onboarding | at least 90% |
| Paper-ledger reconciliation | 100% |
| Required survey completion | at least 70% |

## Publication blockers

- Replace every bracketed placeholder with a tested URL, date, or inbox.
- Confirm sponsor identity, governing jurisdiction, and eligible locations.
- Obtain legal approval for the fixed $500 cash-prize contest.
- Demonstrate that competition accounts cannot submit live orders.
- Demonstrate that ordinary public users cannot enter or view the competition.
- Display paper trading prominently above all performance language.
