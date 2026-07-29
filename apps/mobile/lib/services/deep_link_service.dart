import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class DeepLinkService {
  final AppLinks _appLinks = AppLinks();
  final GlobalKey<NavigatorState> navigatorKey;

  DeepLinkService({required this.navigatorKey});

  void init() {
    _appLinks.getInitialLink().then((uri) {
      if (uri != null) _handleUri(uri);
    }).catchError((_) {
      // AppLinks initial link failed — app continues without initial deep link
    });

    _appLinks.uriLinkStream.listen(_handleUri, onError: (_) {
      // Stream error — running links stop working for this session
    });
  }

  void _handleUri(Uri uri) {
    try {
      final segments = uri.pathSegments;
      if (segments.length < 2) return;

      final type = segments[0];
      final id = segments[1];
      if (type != 'communities' && type != 'events') return;

      Future.delayed(const Duration(milliseconds: 300), () {
        try {
          navigatorKey.currentContext?.go('/$type/$id');
        } catch (_) {
          // Navigation failed — user stays on current screen
        }
      });
    } catch (_) {
      // Malformed URI — ignore
    }
  }
}
