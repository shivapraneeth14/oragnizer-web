DateTime? safeParseDate(String? iso) {
  if (iso == null || iso.isEmpty) return null;
  try {
    return DateTime.parse(iso);
  } catch (_) {
    return null;
  }
}

DateTime? getParsedDate(Map<String, dynamic> map, String key) {
  if (map['_parsed_$key'] is DateTime) return map['_parsed_$key'] as DateTime;
  final parsed = safeParseDate(map[key] as String?);
  if (parsed != null) map['_parsed_$key'] = parsed;
  return parsed;
}

void preParseEventDates(List<Map<String, dynamic>> events) {
  for (final e in events) {
    getParsedDate(e, 'start_date');
    getParsedDate(e, 'end_date');
    getParsedDate(e, 'created_at');
  }
}
