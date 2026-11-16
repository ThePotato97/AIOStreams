// The plugins this build applies itself (kotlin-dsl) resolve here, not through
// the main build's pluginManagement.
pluginManagement {
    repositories {
        // Google's mirror of Maven Central first: Central rate-limits CI runners (429).
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        // Google's mirror of Maven Central first: Central rate-limits CI runners (429).
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    versionCatalogs {
        create("libs") {
            from(files("../gradle/libs.versions.toml"))
        }
    }
}

rootProject.name = "build-logic"
