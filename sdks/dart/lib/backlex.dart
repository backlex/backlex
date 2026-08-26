/// Official Dart client for the backlex API.
///
///     import 'package:backlex/backlex.dart';
///
///     final client = Client('https://api.example.com', apiKey: 'pak_...');
///     final posts = await client.from('posts').query()
///         .where(Filter.eq('published', true)).list();
library backlex;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

part 'src/error.dart';
part 'src/filter.dart';
part 'src/query_builder.dart';
part 'src/collection.dart';
part 'src/auth.dart';
part 'src/storage.dart';
part 'src/realtime.dart';
part 'src/client.dart';
