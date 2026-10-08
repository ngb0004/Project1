import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDate, type CaseHistory, type DiveApi, type LoadedCase } from '@sia/dive-engine';
import { PROCESS_LINE, completionsText, errorMessage } from './copy';
import { SOURCE_TYPE_LABEL } from './Sources';
import { sourceLinkId, testIds, versionRowId } from './testIds';
import { colors, space, type } from './theme';
import { Body, Button, Display, Kicker, Page, Rule, Small, TextLink } from './ui';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; loaded: LoadedCase; history: CaseHistory | null }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/**
 * Per-case transparency page: sources, as-of date, version history and how the
 * dive was researched and approved.
 */
export function TransparencyPage({
  api,
  slug,
  openUrl = (url) => void Linking.openURL(url),
  onBack,
}: {
  api: DiveApi;
  slug: string;
  openUrl?: (url: string) => void;
  onBack?: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoad({ status: 'loading' });
    Promise.all([api.getCase(slug), api.getHistory(slug)]).then(
      ([loaded, history]) => alive && setLoad(loaded ? { status: 'ready', loaded, history } : { status: 'missing' }),
      (e: unknown) => alive && setLoad({ status: 'error', message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [api, slug, attempt]);

  if (load.status !== 'ready') {
    return (
      <View style={styles.centered} testID={testIds.transparency}>
        {load.status === 'loading' ? (
          <ActivityIndicator color={colors.ink} testID={testIds.loading} accessibilityLabel="Loading" />
        ) : load.status === 'missing' ? (
          <Body testID={testIds.notFound}>This dive isn't available.</Body>
        ) : (
          <View style={styles.group} testID={testIds.loadError}>
            <Body>{load.message}</Body>
            <Button label="Try again" onPress={() => setAttempt((n) => n + 1)} />
          </View>
        )}
      </View>
    );
  }

  const { loaded, history } = load;
  const doc = loaded.doc;
  const versions = history?.versions ?? [];

  return (
    <Page testID={testIds.transparency}>
      {onBack ? <TextLink label="Back" onPress={onBack} testID={testIds.back} /> : null}
      <View style={styles.group}>
        <Kicker>How this dive was made</Kicker>
        <Display>{doc.title}</Display>
        <Small>
          Facts current as of {formatDate(doc.as_of)} · Version {loaded.version}, published{' '}
          {formatDate(loaded.published_at)}
        </Small>
      </View>
      <Body>{PROCESS_LINE}</Body>
      <Rule />

      <View style={styles.group} testID={testIds.sources}>
        <Kicker>Sources ({doc.sources.length})</Kicker>
        {doc.sources.map((s) => (
          <View key={s.id} style={styles.source}>
            <Text style={type.caps}>
              {SOURCE_TYPE_LABEL[s.type]} · {formatDate(s.date)}
            </Text>
            <Pressable onPress={() => openUrl(s.url)} accessibilityRole="link" testID={sourceLinkId(s.id)}>
              <Text style={[type.body, styles.link]}>{s.title}</Text>
            </Pressable>
            <Small>
              {s.publisher} · opened {formatDate(s.accessed_at)}
            </Small>
            {s.quote_excerpt ? <Text style={[type.small, styles.excerpt]}>“{s.quote_excerpt}”</Text> : null}
          </View>
        ))}
      </View>
      <Rule />

      <View style={styles.group} testID={testIds.versionHistory}>
        <Kicker>Version history</Kicker>
        {versions.length === 0 ? <Small>No version history yet.</Small> : null}
        {versions.map((v) => (
          <View key={v.version} style={styles.version} testID={versionRowId(v.version)}>
            <Text style={type.body}>
              Version {v.version}
              {v.version === history?.live_version ? ' · live' : ''}
            </Text>
            <Small>
              {v.published_at ? `Published ${formatDate(v.published_at)}` : 'Not published'} · facts as of{' '}
              {formatDate(v.as_of)} · {completionsText(v.completions)}
            </Small>
          </View>
        ))}
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
    backgroundColor: colors.paper,
  },
  group: { gap: space.sm },
  source: { gap: 2, paddingVertical: space.sm },
  link: { textDecorationLine: 'underline', textDecorationColor: colors.rule },
  excerpt: { fontStyle: 'italic' },
  version: { gap: 2, paddingVertical: space.xs },
});
