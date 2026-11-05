# TurtleBot Founding 200 Community Paper Competition

Status: launch-ready draft. Complete every item in the launch addendum before
publishing these rules or inviting testers.

## Summary

TurtleBot will invite 200 approved community members to a private six-week,
forward-only paper trading competition. Every participant starts with $2,000
in simulated funds.
No participant deposits money, purchases entry, connects live execution, or
risks real money. Three winners share a fixed $500 cash prize pool that is
separate from every simulated balance and cannot be increased through payment.

The competition will validate TurtleBot's paper engine, mobile applications,
risk controls, AI Council, Onyx explanations, notifications, and onboarding in
live market conditions. Rankings reward disciplined risk management rather
than reckless leverage.

## Fixed configuration

| Setting | Rule |
| --- | --- |
| Duration | 42 consecutive days |
| Capacity | 200 invited community members plus community alternates |
| Starting balance | $2,000 simulated funds |
| Mode | Paper only; live order submission disabled |
| Markets | BTC, ETH, SOL, DOGE, and XRP competition pairs |
| Leverage | Simulated ceiling of 100x; not a target |
| Risk per trade | Maximum 2% of current paper equity |
| Portfolio risk | Maximum 6% aggregate open risk |
| Council | Council evidence and Onyx verdict recorded for every candidate |
| Strategy changes | Frozen after the opening bell |
| Builds | Configuration versioned; emergency fixes publicly logged |

Before opening, the engine must model fees, spread, slippage, delayed and
rejected fills, funding where applicable, and liquidation.

## Scoring

```text
competition_score =
  net_return_percent
  - (1.5 * maximum_drawdown_percent)
  - (25 * liquidation_count)
  - data_integrity_penalties
```

Ties are broken by lower maximum drawdown, then zero liquidations, then higher
profit factor with at least 20 closed trades, then earlier completion of the
final required beta survey. An account needs at least 20 closed trades or must
have remained continuously signal-eligible for all 42 days to be ranked. The
precise integrity-penalty schedule must be published before registration.

## Official rules

### 1. Sponsor

The verified legal entity operating TurtleBot sponsors and administers the
competition. The repository currently contains the unconfirmed name “Onixus
Inc.” The exact legal name, address, governing jurisdiction, authorized
representative, and working support address must be inserted before launch.

### 2. Eligibility

Entrants must be approved members of the participating TurtleBot community, be
at least 18 years old, reside in an eligible United States jurisdiction, own a
compatible iOS or Android device, and accept these rules, the TurtleBot Terms,
Privacy Policy, Risk Disclosure, and beta terms. Employees, contractors, their
household members, and competition administrators cannot be ranked. Public app
users are not automatically entered. Void where prohibited.

### 3. No purchase or real money

No purchase, subscription, deposit, wallet balance, exchange balance, token, or
entry fee is required. A purchase does not improve access or ranking. Every
balance, fill, profit, loss, and leverage value is simulated, has no cash value,
and cannot be withdrawn or transferred.

### 4. Entry and capacity

Community administrators invite up to 200 eligible members. A seat becomes
active only after the member installs TurtleBot, completes onboarding, joins
the designated community, and accepts the rules. Community alternates may fill
unclaimed seats before the opening bell. One entry per person is allowed.
Reasonable identity verification may be requested, but TurtleBot will never
request seed phrases, private keys, exchange secrets, or wallet passwords.

Competition access must be enforced server-side by community membership and an
active competition-seat record. Possessing an install link or a public
TurtleBot account is not sufficient.

### 5. Competition period

The launch addendum must state the registration deadline, start and end times,
official time zone, and results date before enrollment. Every account resets to
$2,000 at the opening timestamp. Activity outside the window does not count.

### 6. Permitted activity

Participants may use only controls exposed by the approved beta. Onyx,
automation, and AI Council features are allowed when present. Multiple accounts,
external automation, API manipulation, exploiting stale prices, coordinated
manipulation, tampering, or bypassing risk limits is prohibited.

### 7. Winner determination

The formula is applied to server-recorded paper events after an integrity audit.
The leaderboard remains provisional until that audit finishes. Duplicated,
stale, impossible, or corrupted events may be corrected consistently for all
entrants. Every disqualification requires a written audit-log reason.

### 8. Prizes

The fixed prize pool is $500 USD and is awarded to three verified winners:

| Final rank | Cash prize |
| --- | ---: |
| First | $300 |
| Second | $150 |
| Third | $50 |

No other cash or cash-equivalent prize is offered. Simulated balances and paper
profits have no cash value and are never paid out. Winners also receive final
leaderboard placement and non-transferable in-app achievement badges.

Potential winners will be notified through their verified competition email
after the integrity audit. Each must respond within seven calendar days,
confirm eligibility, and complete any legally required eligibility, release,
or tax documentation. Failure to respond or qualify moves the prize to the
next eligible ranked participant. Winners are responsible for taxes required
by their jurisdiction. Payment method, payment deadline, results date, and the
sponsor's verified contact information must appear in the launch addendum.

### 9. Beta availability

Beta software may contain defects, lose simulated state, display delayed data,
or become unavailable. Verified global outages pause scoring when technically
possible. The sponsor may cancel or reschedule if integrity cannot be restored,
with the reason and decision communicated to all participants.

### 10. Financial disclaimer

This is educational product testing, not investment advice, brokerage, custody,
an offer to trade, or evidence of expected returns. Paper and backtested results
do not predict live performance. TurtleBot is non-custodial and live execution
must remain disabled for every competition account.

### 11. Privacy and publicity

The community leaderboard is visible only to enrolled competition members and
authorized community administrators. It uses a participant-selected display
name, never an email, phone number, wallet address, legal name, or exchange
account. Entry grants no advertising rights to a participant's identity,
testimonial, likeness, or trade history. Those uses require separate
affirmative consent.

### 12. Platform disclaimer

Apple and Google are not sponsors, administrators, endorsers, or participants
and have no responsibility for the competition or awards.

### 13. Governing terms

Governing law, disputes, sponsor address, support address, and official
timekeeper require owner and legal confirmation. Applicable law and platform
policy control over conflicting language.

## Launch addendum

Complete these fields before publishing:

- verified sponsor name, address, jurisdiction, and representative;
- working support and privacy inboxes;
- legally confirmed eligible jurisdictions and minimum age;
- registration opening and closing timestamps;
- 42-day competition start and end timestamps and time zone;
- results date and integrity-penalty schedule;
- winner notification date, payment method, and payment deadline;
- TestFlight and Google Play closed-test install links;
- stable rules URL visible inside both applications to enrolled members;
- final build numbers and competition configuration hash; and
- evidence that live execution is disabled for all competition accounts.
- evidence that public users cannot access the competition ledger or leaderboard.

## Release gates

- Twenty internal testers complete onboarding and one full paper trade.
- Physical-device tests pass for deletion, notifications, offline recovery,
  authentication, and crash reporting on iOS and Android.
- Paper ledgers reproduce exactly from immutable events.
- Fee, slippage, funding, rejection, liquidation, and stale-data tests pass.
- Leaderboards reproduce from the same immutable events.
- Community membership and competition-seat authorization fail closed.
- TestFlight external beta review and Google Play closed testing are approved.
- Rules and platform disclaimers are visible inside the app.
- Legal review closes every launch-addendum item.
- Legal review approves the cash-prize contest for every eligible jurisdiction.
