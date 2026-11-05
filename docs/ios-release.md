# Turtle Bot iOS release

The native app loads `https://www.turtlebot.app` and falls back to the bundled
offline screen when the hosted app cannot be reached. Live prices, account data,
and trading remain online-only by design.

## One-time Apple setup

1. Enroll the Onixus organization in the Apple Developer Program.
2. Register the bundle ID `com.onixus.turtlebot` and enable Push Notifications.
3. In Xcode, select the `App` target, choose the Onixus development team, and
   keep automatic signing enabled.
4. Create an APNs signing key in Certificates, Identifiers & Profiles. Store the
   `.p8` key, Key ID, and Team ID in the notification sender's secret store. Never
   commit them to this repository.
5. Apply the `push_device_tokens` Supabase migration before testing registration.

## Build and upload

```bash
npm ci
npm run mobile:sync
npm run mobile:ios
```

In Xcode, select **Any iOS Device (arm64)**, then use **Product → Archive**.
Validate the archive and choose **Distribute App → App Store Connect → Upload**.

For command-line export, copy `ios/ExportOptions.plist.example` outside the
repository, replace the team ID, and run:

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -archivePath build/TurtleBot.xcarchive archive
xcodebuild -exportArchive -archivePath build/TurtleBot.xcarchive -exportOptionsPlist /secure/path/ExportOptions.plist -exportPath build/export
```

The project can register and securely store APNs device tokens. Delivery still
requires the server-side APNs sender credentials described above.

## Xcode Cloud

The repository includes `ios/App/ci_scripts/ci_post_clone.sh`. Xcode Cloud runs
this script after cloning the GitHub repository. It installs Node 22 when the
runner does not provide Node, installs the locked JavaScript dependencies, and
regenerates the Capacitor iOS project assets before Xcode builds the archive.

In App Store Connect, connect the `Onixus-AI/turtle-bot-dashboard` repository,
select `ios/App/App.xcodeproj`, choose the shared `App` scheme, and use an Xcode
26 release image. Keep automatic signing enabled for team `W94TK332WP`. Configure
the archive action for TestFlight; do not add Apple private keys to the source
repository.

Before archiving, run `npm run mobile:release-check`, complete
`docs/store-submission/REVIEW_NOTES.md`, and finish every row in
`docs/store-submission/DEVICE_TEST_MATRIX.md` on physical hardware.
