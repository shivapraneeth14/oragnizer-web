import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/auth_provider.dart';
import '../widgets/auth_text_field.dart';
import '../widgets/auth_button.dart';
import 'package:gotrue/src/types/types.dart' show OAuthProvider;
import '../supabase_client.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _googleLoading = false;

  @override
  void initState() {
    super.initState();
    ref.listenManual(authProvider, (prev, next) {
      if (!mounted) return;
      if (next.session != null && prev?.session != next.session) {
        context.go('/communities');
      }
    });
  }

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  void _signIn() {
    final email = _emailController.text;
    final password = _passwordController.text;
    final notifier = ref.read(authProvider.notifier);
    if (email.isEmpty) {
      notifier.setError('Please enter your email address.');
      return;
    }
    if (password.isEmpty) {
      notifier.setError('Please enter your password.');
      return;
    }
    ref.read(authProvider.notifier).signIn(email, password);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(authProvider);

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 48),
              IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => context.go('/splash'),
              ),
              const SizedBox(height: 24),
              const Text(
                'Welcome back',
                style: TextStyle(
                  fontSize: 28,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'Sign in to your account',
                style: TextStyle(
                  fontSize: 15,
                  color: Colors.grey[600],
                ),
              ),
              const SizedBox(height: 32),
              if (state.error != null)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFEF2F2),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFFECACA)),
                  ),
                  child: Text(
                    state.error!,
                    style: const TextStyle(
                      color: Color(0xFFDC2626),
                      fontSize: 13,
                    ),
                  ),
                ),
              AuthTextField(
                label: 'Email',
                controller: _emailController,
                keyboardType: TextInputType.emailAddress,
              ),
              const SizedBox(height: 20),
              AuthTextField(
                label: 'Password',
                controller: _passwordController,
                obscureText: true,
                showToggle: true,
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => context.go('/forgot-password'),
                  child: const Text('Forgot password?'),
                ),
              ),
              const SizedBox(height: 16),
              AuthButton(
                label: 'Sign In',
                isLoading: state.isLoading,
                onPressed: _signIn,
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: OutlinedButton.icon(
                  onPressed: _googleLoading
                      ? null
                      : () async {
                          setState(() => _googleLoading = true);
                          try {
                            // ignore: avoid_dynamic_calls
                            await (supabase.auth as dynamic).signInWithOAuth(
                              OAuthProvider.google,
                              redirectTo: 'cluvo://login',
                            );
                          } catch (e) {
                            setState(() => _googleLoading = false);
                            if (context.mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text('Google sign-in failed: $e')),
                              );
                            }
                          }
                        },
                  icon: _googleLoading
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.login, size: 18),
                  label: Text(
                    _googleLoading ? 'Connecting...' : 'Continue with Google',
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
                  ),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.grey[700],
                    side: BorderSide(color: Colors.grey[300]!),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    "Don't have an account? ",
                    style: TextStyle(color: Colors.grey[600]),
                  ),
                  TextButton(
                    onPressed: () => context.go('/signup'),
                    child: const Text('Sign up'),
                  ),
                ],
              ),
              const SizedBox(height: 32),
            ],
          ),
        ),
      ),
    );
  }
}
