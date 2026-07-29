import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../providers/auth_provider.dart';
import '../widgets/auth_text_field.dart';
import '../widgets/auth_button.dart';

class ResetPasswordScreen extends ConsumerStatefulWidget {
  const ResetPasswordScreen({super.key});

  @override
  ConsumerState<ResetPasswordScreen> createState() =>
      _ResetPasswordScreenState();
}

class _ResetPasswordScreenState extends ConsumerState<ResetPasswordScreen> {
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();

  @override
  void initState() {
    super.initState();
    ref.listenManual(authProvider, (prev, next) {
      if (!mounted) return;
      if (next.successMessage != null && prev?.successMessage != next.successMessage) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(next.successMessage!),
            backgroundColor: const Color(0xFF10B981),
          ),
        );
        ref.read(authProvider.notifier).clearSuccess();
        context.go('/communities');
      }
    });
  }

  @override
  void dispose() {
    _passwordController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  void _reset() {
    final password = _passwordController.text;
    final confirm = _confirmController.text;

    if (password.isEmpty) {
      _showError('Please enter a new password.');
      return;
    }
    if (confirm.isEmpty) {
      _showError('Please confirm your password.');
      return;
    }
    if (password != confirm) {
      _showError('Passwords do not match.');
      return;
    }
    final passwordError = validatePassword(password);
    if (passwordError != null) {
      _showError(passwordError);
      return;
    }

    ref.read(authProvider.notifier).resetPassword(password);
  }

  void _showError(String message) {
    ref.read(authProvider.notifier).setError(message);
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
              const Text(
                'Set New Password',
                style: TextStyle(
                  fontSize: 28,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Enter your new password below.',
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
                label: 'New Password',
                controller: _passwordController,
                obscureText: true,
                showToggle: true,
                helperText: '8+ characters, 1 capital letter',
              ),
              const SizedBox(height: 20),
              AuthTextField(
                label: 'Confirm Password',
                controller: _confirmController,
                obscureText: true,
                showToggle: true,
              ),
              const SizedBox(height: 24),
              AuthButton(
                label: 'Reset Password',
                isLoading: state.isLoading,
                onPressed: _reset,
              ),
              const SizedBox(height: 32),
            ],
          ),
        ),
      ),
    );
  }
}
