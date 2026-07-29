import 'package:supabase_flutter/supabase_flutter.dart';
import 'config.dart';

final String supabaseUrl = AppConfig.supabaseUrl;
final String supabaseAnonKey = AppConfig.supabaseAnonKey;

final supabase = Supabase.instance.client;
