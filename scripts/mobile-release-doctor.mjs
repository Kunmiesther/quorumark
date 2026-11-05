import { existsSync, readFileSync } from "node:fs";

const checks = [];
const add = (level, name, detail) => checks.push({ level, name, detail });
const has = (path) => existsSync(new URL(`../${path}`, import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

add(
  has("ios/App/App.xcodeproj/project.pbxproj") ? "pass" : "fail",
  "iOS project",
  "Capacitor Xcode project exists",
);
add(
  has("android/app/build.gradle") ? "pass" : "fail",
  "Android project",
  "Capacitor Android project exists",
);
add(
  has("supabase/functions/delete-account/index.ts") ? "pass" : "fail",
  "Account deletion",
  "Authenticated deletion function exists",
);
add(
  has("mobile-shell/index.html") ? "pass" : "fail",
  "Offline screen",
  "Remote-load failure screen exists",
);
add(
  has("android/app/google-services.json") ? "pass" : "fail",
  "Android push",
  "Firebase google-services.json is installed locally",
);
add(
  read("android/app/src/main/AndroidManifest.xml").includes("android.permission.POST_NOTIFICATIONS")
    ? "pass"
    : "fail",
  "Android notification permission",
  "Android 13+ notification permission is declared",
);
add(
  has("ios/App/App/App.entitlements") &&
    read("ios/App/App/App.entitlements").includes("aps-environment")
    ? "pass"
    : "fail",
  "Apple push entitlement",
  "The iOS target declares the APNs entitlement",
);

const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
add(
  /DEVELOPMENT_TEAM = [A-Z0-9]{10};/.test(pbx) ? "pass" : "fail",
  "Apple signing",
  "A 10-character Apple Team ID is configured",
);
add(
  has("ios/ExportOptions.plist") ? "pass" : "fail",
  "Apple export",
  "A local, uncommitted ExportOptions.plist is ready",
);
add(
  has("android/keystore.properties") ? "pass" : "fail",
  "Android signing",
  "A local, uncommitted release keystore config is ready",
);
add(
  has("docs/store-submission/REVIEW_NOTES.md") ? "pass" : "fail",
  "Reviewer notes",
  "Non-custodial and compliance notes exist",
);
add(
  has("docs/store-submission/COMPLIANCE_MATRIX.md") ? "pass" : "fail",
  "Compliance evidence",
  "Submission requirements and fail-closed evidence owners are documented",
);
add(
  has("src/components/trade/DecisionProofPanel.tsx") ? "pass" : "fail",
  "Trading evidence",
  "The Trade desk exposes execution, higher-timeframe, safety, and Council proof",
);
add(
  has("scripts/check-performance-budget.mjs") ? "pass" : "fail",
  "Performance budget",
  "Production asset-size regressions fail a repeatable check",
);
const androidBuild = read("android/app/build.gradle");
add(
  androidBuild.includes("minifyEnabled true") && androidBuild.includes("shrinkResources true")
    ? "pass"
    : "fail",
  "Android release size",
  "Release builds enable code and resource shrinking",
);

const supabaseConfigRef = read("supabase/config.toml").match(/project_id\s*=\s*"([a-z0-9]+)"/)?.[1];
const publicEnvRef = read("src/lib/public-env.ts").match(
  /VITE_SUPABASE_PROJECT_ID:\s*"([a-z0-9]+)"/,
)?.[1];
add(
  Boolean(supabaseConfigRef && publicEnvRef && supabaseConfigRef === publicEnvRef)
    ? "pass"
    : "fail",
  "Supabase target",
  supabaseConfigRef === publicEnvRef
    ? `CLI and application target ${publicEnvRef}`
    : `CLI target ${supabaseConfigRef ?? "missing"} differs from application target ${publicEnvRef ?? "missing"}`,
);

const reviewNotes = read("docs/store-submission/REVIEW_NOTES.md");
add(
  !/\[(REVIEW_[A-Z_]+)\]/.test(reviewNotes) ? "pass" : "fail",
  "Reviewer credentials",
  "Reviewer account and contact placeholders are replaced",
);

for (const check of checks) {
  const icon = check.level === "pass" ? "✓" : "✗";
  console.log(`${icon} ${check.name}: ${check.detail}`);
}

const failures = checks.filter((check) => check.level === "fail");
console.log(`\n${checks.length - failures.length}/${checks.length} release checks passed.`);
if (failures.length) process.exitCode = 1;
