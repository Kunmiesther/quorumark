# Turtle Bot Android release

1. Create a Firebase Android app for `com.onixus.turtlebot` and place its
   uncommitted `google-services.json` at `android/app/google-services.json`.
2. Create the Play upload keystore outside the repository. Copy
   `android/keystore.properties.example` to `android/keystore.properties` and
   replace every placeholder. Both files are ignored by Git.
3. Complete Play Console Financial features, Data safety, account deletion,
   content rating, privacy policy, and app-access declarations.
4. Run `npm run mobile:sync`, `npm run mobile:release-check`, and then:

```bash
cd android
./gradlew clean bundleRelease
```

Upload `android/app/build/outputs/bundle/release/app-release.aab` to Internal
testing first. Complete the physical-device matrix before production review.
