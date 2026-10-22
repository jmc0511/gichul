pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    // AGP 9 에서는 flutter_inappwebview·flutter_web_auth_2 안정판이 아직 빌드되지 않아 8.x 로 둔다
    // (두 플러그인이 AGP 9 를 지원하면 Flutter 기본값으로 되돌릴 수 있다)
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
    // 시험지 완성 알림(FCM). google-services.json 이 있을 때만 app 에서 적용한다
    id("com.google.gms.google-services") version "4.5.0" apply false
}

include(":app")
