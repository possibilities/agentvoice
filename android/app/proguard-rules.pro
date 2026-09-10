# WebRTC calls Java methods through JNI.
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# WebRTC 150 loads JNI Zero by class name during JNI_OnLoad; its AAR has no consumer rules.
-keepclasseswithmembers,includedescriptorclasses class org.jni_zero.** {
    @org.jni_zero.CalledByNative <methods>;
}
