import 'package:flutter/material.dart';
import '../theme.dart';

class AuthTextField extends StatefulWidget {
  final String label;
  final TextEditingController controller;
  final String? hint;
  final bool obscureText;
  final bool showToggle;
  final TextInputType keyboardType;
  final String? errorText;
  final String? helperText;
  final void Function(String)? onChanged;

  const AuthTextField({
    super.key,
    required this.label,
    required this.controller,
    this.hint,
    this.obscureText = false,
    this.showToggle = false,
    this.keyboardType = TextInputType.text,
    this.errorText,
    this.helperText,
    this.onChanged,
  });

  @override
  State<AuthTextField> createState() => _AuthTextFieldState();
}

class _AuthTextFieldState extends State<AuthTextField> {
  late bool _obscured;

  @override
  void initState() {
    super.initState();
    _obscured = widget.obscureText;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          widget.label,
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            color: CluvoTheme.textPrimary,
          ),
        ),
        const SizedBox(height: 6),
        TextField(
          controller: widget.controller,
          obscureText: widget.showToggle ? _obscured : widget.obscureText,
          keyboardType: widget.keyboardType,
          onChanged: widget.onChanged,
          decoration: InputDecoration(
            hintText: widget.hint,
            errorText: widget.errorText,
            suffixIcon: widget.showToggle
                ? IconButton(
                    icon: Icon(
                      _obscured
                          ? Icons.visibility_off_outlined
                          : Icons.visibility_outlined,
                      color: CluvoTheme.textSecondary,
                      size: 20,
                    ),
                    onPressed: () => setState(() => _obscured = !_obscured),
                  )
                : null,
          ),
        ),
        if (widget.helperText != null) ...[
          const SizedBox(height: 4),
          Text(
            widget.helperText!,
            style: TextStyle(
              fontSize: 12,
              color: CluvoTheme.textSecondary.withValues(alpha: 0.7),
            ),
          ),
        ],
      ],
    );
  }
}
