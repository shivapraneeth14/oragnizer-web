import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'app.dart';
import 'supabase_client.dart';
import 'services/deep_link_service.dart';

final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  FlutterError.onError = (details) {
    FlutterError.presentError(details);
  };

  PlatformDispatcher.instance.onError = (error, stack) {
    return true;
  };

  try {
    await Supabase.initialize(
      url: supabaseUrl,
      publishableKey: supabaseAnonKey,
    );
  } catch (e) {
    runApp(_ErrorApp(
      message: 'Could not connect to the server. '
          'Please check your internet connection and restart the app.\n\n'
          'Error: $e',
    ));
    return;
  }

  try {
    DeepLinkService(navigatorKey: navigatorKey).init();
  } catch (e) {
    // Deep link service failed — app continues without deep link handling
  }

  runApp(
    const ProviderScope(
      child: CluvoApp(),
    ),
  );
}

class _ErrorApp extends StatelessWidget {
  final String message;

  const _ErrorApp({required this.message});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        backgroundColor: const Color(0xFFFAFAFA),
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.cloud_off, size: 64, color: Color(0xFFC2185B)),
                  const SizedBox(height: 24),
                  const Text(
                    'Connection Error',
                    style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF171717),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    message,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 14,
                      color: Color(0xFF737373),
                      height: 1.5,
                    ),
                  ),
                  const SizedBox(height: 32),
                  ElevatedButton(
                    onPressed: () {
                      // Re-attempt initialization by restarting the app
                      main();
                    },
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFFC2185B),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 14),
                    ),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
