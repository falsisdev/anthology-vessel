import { definePlugin } from "vessel";
import type { HomeFeed, MediaDetail, SearchPage, StreamResult } from "vessel";
import { rethrowIfDomainBlocked } from "./shared/core/http.ts";
import {
  buildChannelDetail,
  buildLiveHomeSections,
  channelToMediaSummary,
  findChannelByNativeId,
  loadLiveChannels,
  resolveChannelStreams,
} from "./shared/core/live-tv.ts";
import { ultraClean } from "./shared/core/text.ts";
import { EMBEDDED_CHANNELS } from "./channels-data.ts";

const PAGE_SIZE = 36;

export default definePlugin({
  async getHomeFeed(): Promise<HomeFeed> {
    try {
      const channels = await loadLiveChannels(EMBEDDED_CHANNELS);
      return { sections: buildLiveHomeSections(channels) };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { sections: [] };
    }
  },

  async search(
    query: string,
    filters: Record<string, string>,
    page: number,
  ): Promise<SearchPage> {
    try {
      const channels = await loadLiveChannels(EMBEDDED_CHANNELS);
      const q = ultraClean(query);
      const categoryFilter = (filters["category"] ?? filters["section"] ?? "").toLowerCase();

      const filtered = channels.filter((ch) => {
        if (categoryFilter && ch.sectionId !== categoryFilter) {
          return false;
        }
        if (!q) return true;
        return (
          ultraClean(ch.name).includes(q) ||
          ultraClean(ch.id).includes(q) ||
          ultraClean(ch.sectionTitle).includes(q)
        );
      });

      const currentPage = Math.max(1, page || 1);
      const start = (currentPage - 1) * PAGE_SIZE;
      const slice = filtered.slice(start, start + PAGE_SIZE);
      return {
        items: slice.map(channelToMediaSummary),
        hasMore: start + PAGE_SIZE < filtered.length,
      };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { items: [], hasMore: false };
    }
  },

  async getDetails(nativeId: string): Promise<MediaDetail> {
    const channels = await loadLiveChannels(EMBEDDED_CHANNELS);
    const ch = findChannelByNativeId(channels, nativeId);
    if (!ch) {
      throw new Error(`Kanal bulunamadı: ${nativeId}`);
    }
    return buildChannelDetail(ch);
  },

  async getStreams(streamId: string): Promise<StreamResult> {
    try {
      const channels = await loadLiveChannels(EMBEDDED_CHANNELS);
      const ch = findChannelByNativeId(channels, streamId);
      if (!ch) return { streams: [] };
      const streams = await resolveChannelStreams(ch);
      return { streams };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
