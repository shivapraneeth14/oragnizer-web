import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';
import 'package:share_plus/share_plus.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../config.dart';
import '../supabase_client.dart';
import '../widgets/media_gallery.dart';
import '../utils.dart';

class EventDetailScreen extends StatefulWidget {
  final String id;
  const EventDetailScreen({super.key, required this.id});

  @override
  State<EventDetailScreen> createState() => _EventDetailScreenState();
}

class _EventDetailScreenState extends State<EventDetailScreen> {
  Map<String, dynamic>? _event;
  List<Map<String, dynamic>> _media = [];
  bool _loading = true;
  String? _error;
  bool _isRegistered = false;
  bool _checkingRegistration = true;
  bool _registering = false;
  bool _processingPayment = false;
  bool _pollActive = false;
  Razorpay? _razorpay;

  @override
  void initState() {
    super.initState();
    _razorpay = Razorpay();
    _razorpay!.on(Razorpay.EVENT_PAYMENT_SUCCESS, _handlePaymentSuccess);
    _razorpay!.on(Razorpay.EVENT_PAYMENT_ERROR, _handlePaymentError);
    _razorpay!.on(Razorpay.EVENT_EXTERNAL_WALLET, _handleExternalWallet);
    _load();
  }

  @override
  void dispose() {
    _razorpay?.clear();
    super.dispose();
  }

  void _handlePaymentSuccess(PaymentSuccessResponse response) {
    debugPrint('Razorpay success: payment_id=${response.paymentId}, order_id=${response.orderId}');
    if (!mounted) return;
    setState(() => _processingPayment = true);
    _pollRegistrationStatus();
  }

  void _handlePaymentError(PaymentFailureResponse response) {
    debugPrint('Razorpay error: code=${response.code}, message=${response.message}');
    if (!mounted) return;
    setState(() => _processingPayment = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(response.message ?? 'Payment failed. Try again.'), backgroundColor: Colors.red[700]),
    );
  }

  void _handleExternalWallet(ExternalWalletResponse response) {
    debugPrint('Razorpay external wallet: ${response.walletName}');
    if (!mounted) return;
    setState(() => _processingPayment = true);
    _pollRegistrationStatus();
  }

  Future<void> _pollRegistrationStatus() async {
    _pollActive = true;
    for (var i = 0; i < 30; i++) {
      if (!_pollActive) return;
      await Future.delayed(const Duration(seconds: 2));
      try {
        final session = supabase.auth.currentSession;
        if (session == null) continue;
        final res = await supabase
            .from('registrations')
            .select('status')
            .eq('event_id', widget.id)
            .eq('user_id', session.user.id)
            .maybeSingle();
        if (res != null && res['status'] == 'confirmed') {
          _pollActive = false;
          setState(() {
            _isRegistered = true;
            _processingPayment = false;
            _registering = false;
          });
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Registration confirmed!'), backgroundColor: Color(0xFF10B981)),
            );
          }
          return;
        }
        if (res != null && res['status'] == 'cancelled') {
          _pollActive = false;
          setState(() => _processingPayment = false);
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Registration could not be completed.'), backgroundColor: Colors.red[700]),
            );
          }
          return;
        }
      } catch (_) {
        // Retry on next iteration
      }
    }
    _pollActive = false;
    if (!mounted) return;
    setState(() => _processingPayment = false);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Payment verification taking longer than expected. Check your registrations.'), backgroundColor: Colors.orange),
    );
  }

  Future<void> _load() async {
    try {
      final session = supabase.auth.currentSession;
      final eventFuture = supabase
          .from('events')
          .select('*, communities(name)')
          .eq('id', widget.id)
          .single();
      final mediaFuture = supabase
          .from('media')
          .select('*')
          .eq('mediable_type', 'event')
          .eq('mediable_id', widget.id)
          .order('sort_order');

      bool registered = false;
      if (session != null) {
        final results = await Future.wait([
          eventFuture,
          mediaFuture,
          supabase
              .from('registrations')
              .select('id')
              .eq('event_id', widget.id)
              .eq('user_id', session.user.id)
              .eq('status', 'confirmed')
              .isFilter('deleted_at', null)
              .maybeSingle(),
        ]);
        if (!mounted) return;
        registered = results[2] != null;
        final event = results[0] as Map<String, dynamic>?;
        if (event != null) {
          getParsedDate(event, 'start_date');
          getParsedDate(event, 'end_date');
        }
        setState(() {
          _event = event;
          _media = (results[1] as List).cast<Map<String, dynamic>>();
          _isRegistered = registered;
          _loading = false;
          _checkingRegistration = false;
        });
      } else {
        final results = await Future.wait([eventFuture, mediaFuture]);
        if (!mounted) return;
        final event = results[0] as Map<String, dynamic>?;
        if (event != null) {
          getParsedDate(event, 'start_date');
          getParsedDate(event, 'end_date');
        }
        setState(() {
          _event = event;
          _media = (results[1] as List).cast<Map<String, dynamic>>();
          _loading = false;
          _checkingRegistration = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
        _checkingRegistration = false;
      });
    }
  }

  Future<void> _payForEvent() async {
    setState(() => _registering = true);
    try {
      final session = supabase.auth.currentSession;
      if (session == null) return;

      // Step 1: Create booking
      final bookingRes = await supabase.functions.invoke('create-booking',
        body: {'event_id': widget.id},
      );
      if (!mounted) return;
      final registrationId = bookingRes.data['registration_id'] as String?;
      if (registrationId == null) {
        _showError('Failed to create booking.');
        setState(() => _registering = false);
        return;
      }

      // Step 2: Create payment order
      final paymentRes = await supabase.functions.invoke('create-payment-order',
        body: {'registration_id': registrationId},
      );
      if (!mounted) return;
      final orderId = paymentRes.data['razorpay_order_id'] as String?;
      final amount = paymentRes.data['amount'] as int?;
      if (orderId == null || amount == null) {
        _showError('Failed to create payment.');
        setState(() => _registering = false);
        return;
      }

      // Step 3: Open Razorpay Checkout
      final userEmail = session.user.email ?? '';
      final userPhone = session.user.phone ?? '';

      setState(() {
        _registering = false;
        _processingPayment = true;
      });

      final options = {
        'key': AppConfig.razorpayKeyId,
        'amount': amount,
        'currency': 'INR',
        'order_id': orderId,
        'name': 'Cluvo',
        'description': _event?['title'] ?? 'Event Registration',
        'prefill': {'contact': userPhone, 'email': userEmail},
        'theme': {'color': '#C2185B'},
      };

      // Safety timer: if checkout doesn't complete in 90s, reset state
      Future.delayed(const Duration(seconds: 90), () {
        if (mounted && _pollActive) {
          _pollActive = false;
          setState(() {
            _processingPayment = false;
            _registering = false;
          });
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Confirmation timed out. Pull to refresh.'), backgroundColor: Colors.orange),
          );
        }
      });

      _razorpay?.open(options);
    } catch (e) {
      if (!mounted) return;
      _showError('Payment failed: $e');
      setState(() {
        _registering = false;
        _processingPayment = false;
      });
    }
  }

  Future<void> _register() async {
    if (_registering) return;
    setState(() => _registering = true);
    try {
      final session = supabase.auth.currentSession;
      if (session == null) return;
      final res = await supabase.functions.invoke(
        'register-for-event',
        body: {'event_id': widget.id},
      );
      if (!mounted) return;
      if (res.data['success'] == true) {
        setState(() {
          _isRegistered = true;
          _event!['booked_count'] = ((_event!['booked_count'] as num?) ?? 0) + 1;
        });
      } else {
        _showError(res.data['error'] ?? 'Registration failed.');
      }
    } catch (e) {
      if (!mounted) return;
      _showError('Something went wrong. Try again.');
    }
    if (mounted) setState(() => _registering = false);
  }

  Future<void> _cancelRegistration() async {
    if (_registering) return;
    setState(() => _registering = true);
    try {
      final res = await supabase.functions.invoke(
        'cancel-registration',
        body: {'event_id': widget.id},
      );
      if (!mounted) return;
      if (res.data['success'] == true) {
        setState(() {
          _isRegistered = false;
          _event!['booked_count'] = ((_event!['booked_count'] as num?) ?? 1) - 1;
        });
      } else {
        _showError(res.data['error'] ?? 'Cancellation failed.');
      }
    } catch (e) {
      if (!mounted) return;
      _showError('Something went wrong. Try again.');
    }
    if (mounted) setState(() => _registering = false);
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: Colors.red[700]),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading || _checkingRegistration) {
      return Scaffold(body: _buildSkeleton());
    }

    if (_error != null || _event == null) {
      return Scaffold(
        appBar: AppBar(
          leading: IconButton(
            icon: const Icon(Icons.arrow_back),
            onPressed: () => context.pop(),
          ),
        ),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline, size: 40, color: Colors.grey),
                const SizedBox(height: 12),
                Text(_error != null ? 'Error: $_error' : 'Not found',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey[600])),
                const SizedBox(height: 16),
                OutlinedButton.icon(
                  onPressed: () {
                    _loading = true;
                    _checkingRegistration = true;
                    _load();
                  },
                  icon: const Icon(Icons.refresh, size: 16),
                  label: const Text('Tap to Retry'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: const Color(0xFFC2185B),
                    side: const BorderSide(color: Color(0xFFC2185B)),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final e = _event!;
    final imageUrl = e['image_url'] as String?;
    final title = e['title'] as String;
    final price = (e['price'] as num?) ?? 0;
    final capacity = e['capacity'] as int?;
    final booked = (e['booked_count'] as num?) ?? 0;
    final isFull = capacity != null && booked >= capacity;
    final communityName =
        (e['communities'] as Map<String, dynamic>?)?['name'] as String?;

    return Scaffold(
      body: Column(
        children: [
          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: CustomScrollView(
              slivers: [
                SliverAppBar(
                  expandedHeight: 220,
                  pinned: false,
                  stretch: true,
                  backgroundColor: const Color(0xFFC2185B),
                  leading: Container(
                    margin: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.3),
                      shape: BoxShape.circle,
                    ),
                    child: IconButton(
                      icon: const Icon(Icons.arrow_back, color: Colors.white),
                      onPressed: () => context.pop(),
                    ),
                  ),
                  flexibleSpace: FlexibleSpaceBar(
                    background: imageUrl != null && imageUrl.isNotEmpty
                        ? CachedNetworkImage(
                            imageUrl: imageUrl,
                            fit: BoxFit.cover,
                            width: double.infinity,
                            errorWidget: (_, __, ___) =>
                                _buildBannerFallback(title),
                          )
                        : _buildBannerFallback(title),
                  ),
                ),
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Text(
                                title,
                                style: const TextStyle(
                                  fontSize: 22,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                            SizedBox(
                              height: 32,
                              child: IconButton(
                                icon: const Icon(Icons.share, size: 18),
                                style: IconButton.styleFrom(
                                  foregroundColor: const Color(0xFFC2185B),
                                  backgroundColor: const Color(0xFFC2185B)
                                      .withValues(alpha: 0.1),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                ),
                                onPressed: () {
                                  final url =
                                      buildShareUrl('events', widget.id);
                                  Share.share(
                                      'Check out $title on Cluvo!\n$url',
                                      subject: 'Check out $title on Cluvo');
                                },
                              ),
                            ),
                          ],
                        ),
                        if (e['description'] != null) ...[
                          const SizedBox(height: 8),
                          Text(
                            e['description'] as String,
                            style: TextStyle(
                                color: Colors.grey[600], fontSize: 14),
                          ),
                        ],
                        const SizedBox(height: 20),
                        if (communityName != null)
                          _detailRow('Community', communityName),
                        if (e['start_date'] != null)
                          _detailRow('Start',
                              _formatDateTime(_event!, 'start_date')),
                        if (e['end_date'] != null)
                          _detailRow('End',
                              _formatDateTime(_event!, 'end_date')),
                        _detailRow(
                            'Location', e['location'] as String? ?? '—'),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 12, vertical: 6),
                          decoration: BoxDecoration(
                            color: price > 0
                                ? const Color(0xFFC2185B).withValues(alpha: 0.1)
                                : Colors.green.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            price > 0
                                ? '₹${(price / 100).toStringAsFixed(0)}'
                                : 'Free Event',
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              color: price > 0
                                  ? const Color(0xFFC2185B)
                                  : Colors.green,
                            ),
                          ),
                        ),
                        const SizedBox(height: 16),
                        MediaGallery(
                          media: _media,
                          label: 'Event Photos & Videos',
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          ),
          Container(
            decoration: BoxDecoration(
              color: Colors.white,
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.08),
                  blurRadius: 8,
                  offset: const Offset(0, -2),
                ),
              ],
            ),
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Row(
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          'Price',
                          style: TextStyle(
                            fontSize: 11,
                            color: Colors.grey[500],
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          price > 0
                              ? '₹${(price / 100).toStringAsFixed(0)}'
                              : 'Free',
                          style: const TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                    const Spacer(),
                    _buildActionButton(price, isFull),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildActionButton(num price, bool isFull) {
    if (_isRegistered) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Colors.green.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.check_circle, size: 16, color: Colors.green),
                const SizedBox(width: 6),
                const Text(
                  'Registered',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Colors.green,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            height: 36,
            child: OutlinedButton(
              onPressed: _registering ? null : _cancelRegistration,
              style: OutlinedButton.styleFrom(
                foregroundColor: Colors.red,
                side: const BorderSide(color: Colors.red),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
              child: _registering
                  ? const SizedBox(
                      width: 14, height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.red),
                    )
                  : const Text('Cancel', style: TextStyle(fontSize: 13)),
            ),
          ),
        ],
      );
    }

    if (isFull && !_isRegistered) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
        decoration: BoxDecoration(
          color: Colors.grey[200],
          borderRadius: BorderRadius.circular(10),
        ),
        child: const Text(
          'Event Full',
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w600,
            color: Colors.grey,
          ),
        ),
      );
    }

    if (price > 0) {
      return SizedBox(
        height: 44,
        child: ElevatedButton.icon(
          onPressed: (_registering || _processingPayment) ? null : _payForEvent,
          icon: _processingPayment
              ? const SizedBox(
                  width: 16, height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : const Icon(Icons.payment, size: 18),
          label: Text(
            _processingPayment ? 'Processing...' : 'Pay ₹${(price / 100).toStringAsFixed(0)}',
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
          style: ElevatedButton.styleFrom(
            backgroundColor: const Color(0xFFC2185B),
            foregroundColor: Colors.white,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(10),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 28),
          ),
        ),
      );
    }

    return SizedBox(
      height: 44,
      child: ElevatedButton.icon(
        onPressed: _registering ? null : _register,
        icon: _registering
            ? const SizedBox(
                width: 16, height: 16,
                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
              )
            : const Icon(Icons.event, size: 18),
        label: const Text(
          'Register',
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
        style: ElevatedButton.styleFrom(
          backgroundColor: const Color(0xFFC2185B),
          foregroundColor: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 28),
        ),
      ),
    );
  }

  Widget _buildBannerFallback(String title) {
    return Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          colors: [Color(0xFFC2185B), Color(0xFFE0407A)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Center(
        child: Text(
          title.isNotEmpty ? title[0].toUpperCase() : 'E',
          style: const TextStyle(
            color: Colors.white,
            fontSize: 56,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
    );
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 90,
            child: Text(label,
                style: TextStyle(color: Colors.grey[500], fontSize: 13)),
          ),
          Expanded(
            child: Text(value, style: const TextStyle(fontSize: 13)),
          ),
        ],
      ),
    );
  }

  Widget _buildSkeleton() {
    return ListView(
      physics: const NeverScrollableScrollPhysics(),
      children: [
        Container(height: 220, color: Colors.grey[200]),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(height: 20, width: 200, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
              const SizedBox(height: 12),
              Container(height: 14, width: double.infinity, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
              const SizedBox(height: 20),
              ...List.generate(4, (_) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Container(height: 14, width: double.infinity, decoration: BoxDecoration(color: Colors.grey[200], borderRadius: BorderRadius.circular(4))),
              )),
            ],
          ),
        ),
      ],
    );
  }

  String _formatDateTime(Map<String, dynamic> event, String key) {
    final dt = getParsedDate(event, key);
    if (dt == null) return '';
    return '${dt.day}/${dt.month}/${dt.year} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }
}
