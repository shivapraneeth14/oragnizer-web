import 'package:flutter/material.dart';

class DineScreen extends StatelessWidget {
  const DineScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        centerTitle: true,
        title: Text(
          'CLUVO',
          style: TextStyle(
            fontWeight: FontWeight.bold,
            letterSpacing: 2,
            color: const Color(0xFFC2185B),
          ),
        ),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.restaurant,
                  size: 64, color: Colors.grey[300]),
              const SizedBox(height: 16),
              const Text(
                'Dine',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              Text(
                'Coming soon.',
                style: TextStyle(color: Colors.grey[500], fontSize: 14),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
