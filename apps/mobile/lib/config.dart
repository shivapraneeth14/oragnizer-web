class AppConfig {
  AppConfig._();

  static const supabaseUrl = String.fromEnvironment('SUPABASE_URL', defaultValue: 'https://vdxspyumkvwawmqwfkzr.supabase.co');
  static const supabaseAnonKey = String.fromEnvironment('SUPABASE_ANON_KEY', defaultValue: 'sb_publishable_phag39UwA63y44O1703IkA_Ky6ebjwV');
  static const razorpayKeyId = String.fromEnvironment('RAZORPAY_KEY_ID', defaultValue: 'rzp_test_THqWNZqOZGQZOu');
  static const cloudinaryCloudName = String.fromEnvironment('CLOUDINARY_CLOUD_NAME', defaultValue: 'djz0pypu1');
  static const cloudinaryUploadPreset = String.fromEnvironment('CLOUDINARY_UPLOAD_PRESET', defaultValue: 'cluvo_preset');
}

const String appDeepLinkBase = 'cluvo://';

String buildShareUrl(String type, String id) =>
    '$appDeepLinkBase/$type/$id';

