import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'main.dart';
import 'providers/auth_provider.dart';
import 'screens/splash_screen.dart';
import 'screens/login_screen.dart';
import 'screens/signup_screen.dart';
import 'screens/forgot_password_screen.dart';
import 'screens/reset_password_screen.dart';
import 'screens/main_shell.dart';
import 'screens/communities_screen.dart';
import 'screens/community_detail_screen.dart';
import 'screens/events_screen.dart';
import 'screens/event_detail_screen.dart';
import 'screens/dine_screen.dart';
import 'screens/edit_profile_screen.dart';
import 'screens/notifications_screen.dart';
import 'screens/profile_screen.dart';

class CluvoApp extends ConsumerStatefulWidget {
  const CluvoApp({super.key});

  @override
  ConsumerState<CluvoApp> createState() => _CluvoAppState();
}

class _CluvoAppState extends ConsumerState<CluvoApp> {
  late GoRouter _router;

  @override
  void initState() {
    super.initState();
    _router = GoRouter(
      initialLocation: '/splash',
      redirect: _redirect,
      errorBuilder: (context, state) => Scaffold(
        backgroundColor: const Color(0xFFFAFAFA),
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.link_off, size: 48, color: Colors.grey),
                  const SizedBox(height: 16),
                  Text(
                    'Page not found: "${state.uri.toString()}"',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Colors.grey, fontSize: 14),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
      routes: [
        GoRoute(
          path: '/',
          redirect: (_, _) => '/splash',
        ),
        GoRoute(
          path: '/splash',
          builder: (context, state) => const SplashScreen(),
        ),
        GoRoute(
          path: '/login',
          pageBuilder: (context, state) => CustomTransitionPage(
            key: state.pageKey,
            child: const LoginScreen(),
            transitionsBuilder: (context, animation, secondaryAnimation, child) {
              return SlideTransition(
                position: Tween<Offset>(
                  begin: const Offset(0, 1),
                  end: Offset.zero,
                ).animate(CurvedAnimation(
                  parent: animation,
                  curve: Curves.easeOut,
                )),
                child: child,
              );
            },
          ),
        ),
        GoRoute(
          path: '/signup',
          pageBuilder: (context, state) => CustomTransitionPage(
            key: state.pageKey,
            child: const SignupScreen(),
            transitionsBuilder: (context, animation, secondaryAnimation, child) {
              return SlideTransition(
                position: Tween<Offset>(
                  begin: const Offset(0, 1),
                  end: Offset.zero,
                ).animate(CurvedAnimation(
                  parent: animation,
                  curve: Curves.easeOut,
                )),
                child: child,
              );
            },
          ),
        ),
        GoRoute(
          path: '/forgot-password',
          pageBuilder: (context, state) => CustomTransitionPage(
            key: state.pageKey,
            child: const ForgotPasswordScreen(),
            transitionsBuilder: (context, animation, secondaryAnimation, child) {
              return SlideTransition(
                position: Tween<Offset>(
                  begin: const Offset(0, 1),
                  end: Offset.zero,
                ).animate(CurvedAnimation(
                  parent: animation,
                  curve: Curves.easeOut,
                )),
                child: child,
              );
            },
          ),
        ),
        GoRoute(
          path: '/reset-password',
          pageBuilder: (context, state) => CustomTransitionPage(
            key: state.pageKey,
            child: const ResetPasswordScreen(),
            transitionsBuilder: (context, animation, secondaryAnimation, child) {
              return FadeTransition(
                opacity: animation,
                child: child,
              );
            },
          ),
        ),
        GoRoute(
          path: '/edit-profile',
          builder: (context, state) => const EditProfileScreen(),
        ),
        GoRoute(
          path: '/notifications',
          builder: (context, state) => const NotificationsScreen(),
        ),
        StatefulShellRoute.indexedStack(
          builder: (context, state, navigationShell) =>
              MainShell(navigationShell: navigationShell),
          branches: [
            StatefulShellBranch(
              routes: [
                GoRoute(
                  path: '/communities',
                  builder: (context, state) => const CommunitiesScreen(),
                ),
                GoRoute(
                  path: '/communities/:id',
                  builder: (context, state) => CommunityDetailScreen(
                    id: state.pathParameters['id']!,
                  ),
                ),
              ],
            ),
            StatefulShellBranch(
              routes: [
                GoRoute(
                  path: '/events',
                  builder: (context, state) => const EventsScreen(),
                ),
                GoRoute(
                  path: '/events/:id',
                  builder: (context, state) => EventDetailScreen(
                    id: state.pathParameters['id']!,
                  ),
                ),
              ],
            ),
            StatefulShellBranch(
              routes: [
                GoRoute(
                  path: '/dine',
                  builder: (context, state) => const DineScreen(),
                ),
              ],
            ),
            StatefulShellBranch(
              routes: [
                GoRoute(
                  path: '/profile',
                  builder: (context, state) => const ProfileScreen(),
                ),
              ],
            ),
          ],
        ),
      ],
    );
  }

  String? _redirect(BuildContext context, GoRouterState state) {
    final auth = ref.read(authProvider);
    final loggedIn = auth.session != null;
    final location = state.uri.toString();

    if (location == '/') return '/splash';

    final authPaths = [
      '/splash',
      '/login',
      '/signup',
      '/forgot-password',
      '/reset-password',
    ];

    if (auth.isRecovery && location != '/reset-password') {
      return '/reset-password';
    }

    if (loggedIn && !auth.isRecovery && authPaths.contains(location)) {
      return '/communities';
    }
    if (!loggedIn && !authPaths.contains(location)) {
      return '/login';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AuthState>(authProvider, (_, _) => _router.refresh());
    return MaterialApp.router(
      key: navigatorKey,
      title: 'Cluvo',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        fontFamily: 'Inter',
        scaffoldBackgroundColor: const Color(0xFFFAFAFA),
          colorScheme: const ColorScheme.light(
            primary: Color(0xFFC2185B),
            secondary: Color(0xFFC2185B),
          ),
      ),
      builder: (context, child) {
        ErrorWidget.builder = (errorDetails) => Scaffold(
          backgroundColor: const Color(0xFFFAFAFA),
          body: SafeArea(
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.error_outline, size: 48, color: Colors.grey),
                    const SizedBox(height: 16),
                    const Text(
                      'Something went wrong. Please restart the app.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.grey, fontSize: 14),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
        return child!;
      },
      routerConfig: _router,
    );
  }
}
