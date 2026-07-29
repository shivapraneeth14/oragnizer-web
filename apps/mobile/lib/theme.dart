import 'package:flutter/material.dart';

class CluvoTheme {
  static const Color primary = Color(0xFFC2185B);
  static const Color primaryHover = Color(0xFFA0154A);
  static const Color background = Color(0xFFFAFAFA);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color textPrimary = Color(0xFF171717);
  static const Color textSecondary = Color(0xFF737373);
  static const Color border = Color(0xFFE5E5E5);
  static const Color error = Color(0xFFEF4444);
  static const Color success = Color(0xFF10B981);

  static const double radiusSm = 4;
  static const double radiusMd = 8;
  static const double radiusLg = 12;
  static const double radiusXl = 16;

  static ThemeData get theme => ThemeData(
        useMaterial3: true,
        fontFamily: 'Inter',
        scaffoldBackgroundColor: background,
        colorScheme: ColorScheme.light(
          primary: primary,
          error: error,
          surface: surface,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: surface,
          contentPadding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(radiusMd),
            borderSide: BorderSide(color: border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(radiusMd),
            borderSide: BorderSide(color: border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(radiusMd),
            borderSide: BorderSide(color: primary, width: 1.5),
          ),
          errorBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(radiusMd),
            borderSide: BorderSide(color: error),
          ),
          labelStyle: TextStyle(color: textSecondary, fontSize: 14),
          hintStyle: TextStyle(color: textSecondary.withValues(alpha: 0.5), fontSize: 14),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: primary,
            foregroundColor: Colors.white,
            minimumSize: const Size(double.infinity, 48),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(radiusMd),
            ),
            textStyle: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        textButtonTheme: TextButtonThemeData(
          style: TextButton.styleFrom(
            foregroundColor: primary,
            textStyle: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
      );
}
