import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import '../supabase_client.dart';
import 'profile_provider.dart';
import 'community_provider.dart';
import 'notification_provider.dart';

final _capitalLetter = RegExp(r'[A-Z]');

String? validatePassword(String password) {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!_capitalLetter.hasMatch(password)) return 'Password needs at least one capital letter.';
  return null;
}

class AuthState {
  final bool isLoading;
  final String? error;
  final String? successMessage;
  final Session? session;
  final bool usernameAvailable;
  final bool isRecovery;
  final bool checkingUsername;

  const AuthState({
    this.isLoading = false,
    this.error,
    this.successMessage,
    this.session,
    this.usernameAvailable = true,
    this.isRecovery = false,
    this.checkingUsername = false,
  });

  AuthState copyWith({
    bool? isLoading,
    String? error,
    String? successMessage,
    Session? session,
    bool? usernameAvailable,
    bool? isRecovery,
    bool? checkingUsername,
    bool clearError = false,
    bool clearSuccess = false,
    bool clearSession = false,
  }) {
    return AuthState(
      isLoading: isLoading ?? this.isLoading,
      error: clearError ? null : error ?? this.error,
      successMessage: clearSuccess ? null : successMessage ?? this.successMessage,
      session: clearSession ? null : session ?? this.session,
      usernameAvailable: usernameAvailable ?? this.usernameAvailable,
      isRecovery: clearSession ? false : isRecovery ?? this.isRecovery,
      checkingUsername: checkingUsername ?? this.checkingUsername,
    );
  }
}

class AuthNotifier extends StateNotifier<AuthState> {
  StreamSubscription? _authSub;
  final Ref _ref;

  AuthNotifier(this._ref) : super(const AuthState()) {
    try {
      _init();
      _listenAuthChanges();
    } catch (_) {
      // Auth initialization failed — state remains empty, user sees login
    }
  }

  @override
  void dispose() {
    _authSub?.cancel();
    super.dispose();
  }

  void _init() {
    try {
      state = state.copyWith(session: supabase.auth.currentSession);
    } catch (_) {
      // currentSession unavailable — user stays logged out
    }
  }

  void _listenAuthChanges() {
    try {
      _authSub = supabase.auth.onAuthStateChange.listen((data) {
        try {
          if (data.event == AuthChangeEvent.passwordRecovery) {
            state = state.copyWith(session: supabase.auth.currentSession, isRecovery: true);
          }
          if (data.event == AuthChangeEvent.signedOut) {
            state = state.copyWith(clearSession: true);
            _invalidateDependentProviders();
          }
        } catch (_) {
          // Individual auth event handler failed — ignored
        }
      }, onError: (_) {
        // Stream error — subscription terminated; auth changes stop being detected
      });
    } catch (_) {
      // Failed to subscribe to auth changes — app continues without realtime auth sync
    }
  }

  void _invalidateDependentProviders() {
    _ref.invalidate(profileProvider);
    _ref.invalidate(myCommunitiesProvider);
    _ref.invalidate(notificationsProvider);
    _ref.invalidate(unreadCountProvider);
  }

  void setError(String message) {
    state = state.copyWith(error: message, clearSuccess: true);
  }

  void clearMessages() {
    state = state.copyWith(clearError: true, clearSuccess: true);
  }

  void clearSuccess() {
    state = state.copyWith(clearSuccess: true);
  }

  Future<void> checkSession() async {
    try {
      state = state.copyWith(session: supabase.auth.currentSession);
    } catch (_) {
      state = state.copyWith(clearSession: true);
    }
  }

  Future<void> signIn(String email, String password) async {
    if (state.isLoading) return;
    state = state.copyWith(isLoading: true, clearError: true, clearSuccess: true);
    try {
      final result = await supabase.auth.signInWithPassword(
        email: email.trim(),
        password: password,
      ).timeout(const Duration(seconds: 15));
      state = state.copyWith(isLoading: false, session: result.session);
    } on AuthException catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: _friendlyAuthError(e.message),
      );
    } on TimeoutException {
      state = state.copyWith(isLoading: false, error: 'Request timed out. Try again.');
    } catch (_) {
      state = state.copyWith(
        isLoading: false,
        error: 'Connection error. Check your internet and try again.',
      );
    }
  }

  Future<bool> checkUsername(String username) async {
    state = state.copyWith(checkingUsername: true);
    try {
      final response = await supabase.functions.invoke(
        'check-username',
        body: {'username': username.trim()},
      ).timeout(const Duration(seconds: 10));
      final available = response.data['available'] as bool;
      state = state.copyWith(checkingUsername: false, usernameAvailable: available);
      return available;
    } catch (_) {
      state = state.copyWith(
        checkingUsername: false,
        usernameAvailable: false,
        error: 'Could not verify username. Check your connection.',
      );
      return false;
    }
  }

  Future<void> signUp(
    String email,
    String password,
    String firstName,
    String lastName,
    String username,
  ) async {
    if (state.isLoading) return;
    state = state.copyWith(isLoading: true, clearError: true, clearSuccess: true);

    try {
      final response = await supabase.functions.invoke(
        'register',
        body: {
          'email': email.trim(),
          'password': password,
          'first_name': firstName.trim(),
          'last_name': lastName.trim(),
          'username': username.trim(),
        },
      ).timeout(const Duration(seconds: 15));

      if (response.data['success'] == true) {
        state = state.copyWith(
          isLoading: false,
          successMessage: 'Account created! Sign in to continue.',
        );
      } else {
        state = state.copyWith(
          isLoading: false,
          error: response.data['error'] ?? 'Something went wrong. Try again.',
        );
      }
    } on TimeoutException {
      state = state.copyWith(isLoading: false, error: 'Request timed out. Try again.');
    } catch (_) {
      state = state.copyWith(
        isLoading: false,
        error: 'Connection error. Check your internet and try again.',
      );
    }
  }

  Future<void> sendResetLink(String email) async {
    if (state.isLoading) return;
    state = state.copyWith(isLoading: true, clearError: true, clearSuccess: true);
    try {
      await supabase.auth.resetPasswordForEmail(
        email.trim(),
        redirectTo: 'cluvo://login',
      );
      state = state.copyWith(
        isLoading: false,
        successMessage: 'Check your email for the reset link.',
      );
    } on AuthException catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: _friendlyAuthError(e.message),
      );
    } catch (_) {
      state = state.copyWith(
        isLoading: false,
        error: 'Connection error. Check your internet and try again.',
      );
    }
  }

  Future<void> resetPassword(String newPassword) async {
    if (state.isLoading) return;
    final validationError = validatePassword(newPassword);
    if (validationError != null) {
      state = state.copyWith(error: validationError);
      return;
    }

    state = state.copyWith(isLoading: true, clearError: true, clearSuccess: true);
    try {
      await supabase.auth.updateUser(UserAttributes(password: newPassword))
          .timeout(const Duration(seconds: 15));
      state = state.copyWith(
        isLoading: false,
        isRecovery: false,
        successMessage: 'Password updated successfully!',
      );
    } on AuthException catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: _friendlyAuthError(e.message),
      );
    } on TimeoutException {
      state = state.copyWith(isLoading: false, error: 'Request timed out. Try again.');
    } catch (_) {
      state = state.copyWith(
        isLoading: false,
        error: 'Connection error. Check your internet and try again.',
      );
    }
  }

  Future<void> signOut() async {
    state = state.copyWith(isLoading: true, clearError: true, clearSuccess: true);
    try {
      await supabase.auth.signOut().timeout(const Duration(seconds: 10));
    } on AuthException catch (e) {
      state = state.copyWith(isLoading: false, error: _friendlyAuthError(e.message));
      return;
    } on TimeoutException {
      // API hung — still clear local state
    } catch (_) {
      // Network error — still clear local state
    }
    state = state.copyWith(isLoading: false, clearSession: true);
  }

  String _friendlyAuthError(String message) {
    if (message.contains('Invalid login credentials')) {
      return 'Invalid email or password. Please try again.';
    }
    if (message.contains('Email not confirmed')) {
      return 'Please confirm your email address.';
    }
    if (message.contains('User already registered')) {
      return 'An account with this email already exists.';
    }
    return message;
  }
}

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier(ref);
});
