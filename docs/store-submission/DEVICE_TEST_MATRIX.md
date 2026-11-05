# Release device test matrix

Every row must pass on a physical device before public submission. Record the
device, OS version, build number, tester, and evidence link in the release ticket.

- Fresh install → onboarding → email verification → Paper mode
- Sign in with Apple, Google, and email/password; cancellation and failure paths
- App relaunch with an existing and an expired session
- Ask Onyx with AI permission off, then on, then revoked
- Council key add/replace/remove without exposing the stored secret
- Coinbase/Kraken connection failure and success; withdrawal permission rejected
- Paper trade open/close; 15-minute execution and 1-hour/4-hour setup display
- Live controls remain blocked unless every entitlement and safety gate passes
- Network loss at launch and while active; offline screen and retry behavior
- Push opt-in, foreground delivery, background delivery, tap destination, opt-out
- Dynamic Type/text scaling, VoiceOver/TalkBack, reduced motion, and 44pt targets
- Safe areas, keyboard, rotation policy, and background/foreground transitions
- Account deletion removes access, data, credentials, and active sessions
- Cold launch, memory pressure, crash reporting, and slow-network performance
