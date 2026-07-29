import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/auth_provider.dart';
import '../theme.dart';

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _fadeIn;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    );
    _fadeIn = CurvedAnimation(parent: _controller, curve: Curves.easeIn);
    _controller.forward();
    _checkSession();
  }

  Future<void> _checkSession() async {
    try {
      await Future.delayed(const Duration(milliseconds: 1200));
      if (!mounted) return;
      final session = ref.read(authProvider).session;
      if (session != null) {
        context.go('/communities');
      } else {
        context.go('/login');
      }
    } catch (_) {
      // Session check or navigation failed — redirect will handle it on next refresh
      if (mounted) context.go('/login');
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: CluvoTheme.background,
      body: Center(
        child: FadeTransition(
          opacity: _fadeIn,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 80,
                height: 80,
                decoration: BoxDecoration(
                  color: CluvoTheme.primary,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: const Icon(
                  Icons.groups_rounded,
                  color: Colors.white,
                  size: 40,
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'CLUVO',
                style: TextStyle(
                  fontSize: 32,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 4,
                  color: CluvoTheme.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Connecting communities',
                style: TextStyle(
                  fontSize: 14,
                  color: CluvoTheme.textSecondary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
