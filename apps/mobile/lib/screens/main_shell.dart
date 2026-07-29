import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

const _indicatorColor = Color(0x1FC2185B);

class MainShell extends StatelessWidget {
  final StatefulNavigationShell navigationShell;

  const MainShell({super.key, required this.navigationShell});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: (index) => navigationShell.goBranch(index),
        indicatorColor: _indicatorColor,
        destinations: [
          NavigationDestination(
            icon: Icon(Icons.groups_outlined,
                color: navigationShell.currentIndex == 0
                    ? const Color(0xFFC2185B)
                    : null),
            selectedIcon: const Icon(Icons.groups, color: Color(0xFFC2185B)),
            label: 'Communities',
          ),
          NavigationDestination(
            icon: Icon(Icons.event_outlined,
                color: navigationShell.currentIndex == 1
                    ? const Color(0xFFC2185B)
                    : null),
            selectedIcon: const Icon(Icons.event, color: Color(0xFFC2185B)),
            label: 'Events',
          ),
          NavigationDestination(
            icon: Icon(Icons.restaurant_outlined,
                color: navigationShell.currentIndex == 2
                    ? const Color(0xFFC2185B)
                    : null),
            selectedIcon:
                const Icon(Icons.restaurant, color: Color(0xFFC2185B)),
            label: 'Dine',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outlined,
                color: navigationShell.currentIndex == 3
                    ? const Color(0xFFC2185B)
                    : null),
            selectedIcon: const Icon(Icons.person, color: Color(0xFFC2185B)),
            label: 'Profile',
          ),
        ],
      ),
    );
  }
}
