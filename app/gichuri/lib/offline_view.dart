// 첫 화면을 못 불러왔을 때 보여 주는 화면.
import 'package:flutter/material.dart';

import 'main.dart';

class OfflineView extends StatelessWidget {
  const OfflineView({required this.onRetry, super.key});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: kBackground,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.wifi_off_rounded, size: 44, color: Color(0xFF98A1B0)),
              const SizedBox(height: 18),
              const Text(
                '인터넷에 연결되지 않았어요',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: Color(0xFFE5E8ED)),
              ),
              const SizedBox(height: 8),
              const Text(
                'Wi-Fi 나 데이터를 확인하고 다시 시도해 주세요.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 15, height: 1.5, color: Color(0xFF98A1B0)),
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: onRetry,
                style: FilledButton.styleFrom(
                  backgroundColor: kAccent,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 14),
                ),
                child: const Text('다시 시도', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 사이트가 뜨기 전 잠깐 보이는 화면 (스플래시와 같은 색).
class LoadingView extends StatelessWidget {
  const LoadingView({super.key});

  @override
  Widget build(BuildContext context) {
    return const ColoredBox(
      color: kBackground,
      child: Center(
        child: SizedBox(
          width: 28,
          height: 28,
          child: CircularProgressIndicator(strokeWidth: 2.4, color: kAccent),
        ),
      ),
    );
  }
}
