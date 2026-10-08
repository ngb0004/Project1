import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDate, type LiveCaseSummary } from '@sia/dive-engine';
import {
  Body,
  Button,
  Display,
  Kicker,
  Page,
  Rule,
  Small,
  TextLink,
  Title,
  colors,
  errorMessage,
  space,
} from '@sia/dive-ui';
import { BackendNotice, Loading, Screen } from '@/components/Screen';
import { useBackend } from '@/lib/backend';

export default function Home() {
  const backend = useBackend();
  const router = useRouter();
  const [cases, setCases] = useState<LiveCaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (backend.status !== 'ready') return;
    let alive = true;
    backend.api.listLiveCases().then(
      (rows) => alive && setCases(rows),
      (e: unknown) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [backend]);

  if (backend.status !== 'ready') {
    return (
      <Screen>
        <BackendNotice backend={backend} />
      </Screen>
    );
  }

  const open = (slug: string) => router.push({ pathname: '/case/[slug]', params: { slug } });
  const about = (slug: string) => router.push({ pathname: '/case/[slug]/about', params: { slug } });
  const [featured, ...others] = cases ?? [];

  return (
    <Screen>
      <Page testID="home">
        <View style={styles.group}>
          <Kicker>Dive</Kicker>
          <Display>One story, laid out calmly.</Display>
          <Body style={styles.muted}>
            Record your gut answer. Walk through the facts one at a time. See where you move, and where everyone else
            does.
          </Body>
        </View>
        <Rule />
        {error ? <Small testID="home-error">{error}</Small> : null}
        {!cases && !error ? <Loading /> : null}
        {cases && cases.length === 0 ? (
          <Body testID="home-empty">No dive is live right now. Check back soon.</Body>
        ) : null}
        {featured ? (
          <View style={styles.featured} testID="featured-case">
            <Kicker>Live now · facts as of {formatDate(featured.as_of)}</Kicker>
            <Pressable onPress={() => open(featured.slug)} accessibilityRole="link">
              <Display>{featured.title}</Display>
            </Pressable>
            <Small>
              {featured.step_count} facts{featured.content_warning ? ' · Content warning' : ''}
            </Small>
            <Button label="Start the dive" onPress={() => open(featured.slug)} testID="open-case" />
            <TextLink
              label="How this dive was made"
              onPress={() => about(featured.slug)}
              accessibilityRole="link"
              testID="open-about"
            />
          </View>
        ) : null}
        {others.length > 0 ? (
          <View style={styles.group}>
            <Kicker>Also live</Kicker>
            {others.map((c) => (
              <Pressable
                key={c.case_id}
                onPress={() => open(c.slug)}
                accessibilityRole="link"
                style={styles.other}
                testID={`case-${c.slug}`}
              >
                <Title>{c.title}</Title>
                <Small>
                  {c.step_count} facts · as of {formatDate(c.as_of)}
                </Small>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Page>
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: space.sm },
  muted: { color: colors.muted },
  featured: { gap: space.md },
  other: {
    gap: space.xs,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.rule,
  },
});
