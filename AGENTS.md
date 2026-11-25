# Proje Kuralları — Anthology (Vessel Native TypeScript)

## Oturum Başlangıcı — Zorunlu Adım
Her oturumda ve her promptta, işe başlamadan ÖNCE:
1. En son Antigravity hafızasını kontrol et: `~/.gemini/antigravity/brain/` altındaki en yeni oturum (en son değiştirilmiş dizin).
2. `walkthrough.md` ve `implementation_plan.md` dosyalarını oku.
3. Önceki oturumun nereye kadar gittiğini, yarıda kesilip kesilmediğini belirle ve oradan devam et.
4. `git status` ile commit edilmemiş/yarım kalmış değişiklikleri kontrol et.

Bu adım hiçbir zaman atlanmaz; her yeni promptta tekrar gerekirse durum kontrolü yapılır.

## Git Temizliği — AI Kalıntısı Yasağı
- Commit'lerde ASLA AI kalıntısı dosyası bulunmaz: walkthrough/implementation plan/hafıza/brain dökümleri, AI notları, geçici çıktılar veya `dist/` `.plugin.vessel` paketleri.
- Bu tür dosyalar repo'ya eklenmez, `.gitignore`'da kalır.
- Yeni bir AI ile ilgili dosya/klasör oluşturulursa önce `.gitignore`'a eklenir.
- Yalnızca commit'e girecek dosyalar `git add <dosya>` ile açıkça eklenir; asla `git add .` kullanılmaz.
- Commit mesajları DAİMA İngilizce yazılır (başlık + gövde). Türkçe commit mesajı YASAK.
- Conventional commit başlığında sürüm adı YAZILMAZ (örn. `1.0.1: ...` YASAK; `fix: ...`, `feat: ...`, `refactor: ...`). Sürüm yalnızca ciddi değişikliklerde `package.json`, `config.json`, `repo.json` ve etkilenen `manifest.json` dosyalarında senkronize biçimde artırılır.

## Oturum Boyunca
- Kullanıcı istedikçe bu dosya (`AGENTS.md`) güncellenir; yeni öğrenilen kalıcı kurallar buraya eklenir.
- İlerleme durumu ve son doğrulanan sürüm bilgisi bu dosyanın altındaki `Devam Noktası` bölümüne işlenir.

## Eşzamanlı Agent Çalışması
- Bazen aynı anda birden fazla agent çalışabilir. Her agent yalnızca kendi görevine odaklanır.
- Bir agent, eşzamanlı çalışan başka bir agent'ın yaptığı değişiklikleri (dosya düzenlemeleri, sürüm değişiklikleri vb.) GÖRMEZDEN GELİR — kendi işini bozmadığı sürece müdahale etmez ve geri almaz.
- `git status`'ta kendi commit'ine ait olmayan değişiklikler görülürse bunlar olduğu gibi bırakılır.

## Vessel Eklenti Mimarisi ve Geliştirme Kuralları

### 1. Tek Yerden Eklenti Mimarisi (`core/` + `extractors/` + `plugins/<id>/`)
- **Paylaşılan modüller**: Çekirdek yardımcılar `core/` (ör. `core/http.ts`, `core/config.ts`, `core/tmdb.ts`, `core/live-tv.ts`, `core/exact-tmdb-sources.ts`) ve video çözücüler `extractors/` altında tutulur.
- **Eklentiler (`plugins/<id>/`)**: Her eklenti yalnızca tek bir yerde (`plugins/<id>/manifest.json` + `plugins/<id>/index.ts`) geliştirilir. `scripts/sync-plugins.ts` çalıştırıldığında her eklentinin içe aktardığı çekirdek/çözücü modülleri `plugins/<id>/shared/...` altına senkronize eder ve kök `repo.json` dosyasını günceller (`../` kaçışı olmadan kendi kendine yeten paket).
- **Asla elle düzenleme**: `plugins/<id>/shared/`, `plugins/anthology-tv/channels-data.ts` ve `repo.json` dosyalarını elle düzenleme. Paylaşılan değişiklikleri `core/`, `extractors/` veya `data/canli.m3u` üzerinde yapıp `npm run sync` çalıştır.
- **`repo.json` kuralı**: Her `RepoPluginEntry` için `sourcePath` alanı eklenti kök klasörünü göstermelidir (`"plugins/<id>"` — `.../manifest.json` DEĞİL). `Vessel` `SourceResolver` manifest yolunu bu kök üzerinden çözer.

### 2. Katı `oxc` + QuickJS TypeScript Kısıtları
- `tsconfig.json` (`strict`, `isolatedModules`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `allowImportingTsExtensions`) Vessel'ın Rust `oxc` type-stripper ve QuickJS ESM loader'ı ile birebir hizalıdır:
  - `enum`, `namespace`, constructor parametre özellikleri (`private x: string`) ve CommonJS (`require`, `module.exports`) YASAKTIR.
  - Yalnızca `import type { ... }` tip içe aktarmaları ile `"vessel"` ve eklenti paketi içindeki göreceli (`./shared/core/...`, `./channels-data.ts`) `.ts` içe aktarmalarına izin verilir.
  - Node.js yerli modülleri (`node:fs`, `node:crypto`, `node:path`) ve harici npm paketleri (`cheerio`, `axios`, `crypto-js`) `core/`, `extractors/` veya `plugins/` içine İTHAL EDİLMEZ (sadece `scripts/` içindeki yerel araç/test betikleri Node kullanabilir).
  - QuickJS ESM yükleyicisi doğrudan `.json` import desteklemez; veri dosyaları `.ts` modülü olarak (`channels-data.ts` gibi) üretilir.

### 3. Yerel Vessel SDK, Güvenlik ve Alan Adı Politikası
- Tüm eklentiler `import { definePlugin, http, html, crypto, storage, unpack, evalWithEnv } from "vessel"` sözleşmesini kullanır (`core/http.ts`, `core/config.ts`, `core/text.ts`, `core/quality.ts`, `core/tmdb.ts`, `core/plugin-helpers.ts`, `core/anime-helpers.ts`, `core/exact-tmdb-sources.ts`).
- `allowAnyHttps` DAİMA kapalı (`false`/tanımsız) tutulur. JS içinde istek atılan HER host (`api.themoviedb.org`, `raw.githubusercontent.com`, site mirror'ları, gömülü oynatıcılar ve CDN API'leri) `manifest.json` içindeki `domains` listesinde bulunmalıdır.
- `[VesselDomainBlockedError]` hatası ASLA `try { ... } catch {}` ile yutulmaz — her zaman `rethrowIfDomainBlocked(err)` ile yukarı fırlatılır ki Vessel izin isteme ekranı tetiklenebilsin.

### 4. Alan Modelleri, Yayın ve Arayüz Kuralları
- **Kullanıcı dili**: Vessel içindeki eklenti adları, açıklamaları, bölüm başlıkları, yayın etiketleri ve `settingsSchema` alan etiketleri **Türkçe** yazılır.
- **`MediaType` değişmezi**: `type` yalnızca `"movie" | "series" | "live"` olabilir (`"anime"` yasaktır). Anime eklentileri `type: "series"` (veya filmse `"movie"`), `isAnime: true` ve manifest içinde `"contentTypes": ["anime"]` kullanır.
- **Yayın kalitesi ve proxy kuralları**:
  - Pilavyer, CloseLoad, Vixolity, FastPlay gibi adaptif HLS master manifestoları alt akışa kırpılmaz; `master.m3u8` korunur.
  - `Referer`, `Origin` veya özel `User-Agent` gerektiren tüm akışlar `createStream(...)` üzerinden otomatik olarak `flags: ["requires_proxy"]` alır.
  - `finalizeStreams(...)` ile URL tekilleştirme + kalite sıralaması (`sortStreamsByQuality`) uygulanır.
- **Canlı TV (`anthology-tv`)**:
  - 7 Anthology canlı kategorisi (`Canlı Spor`, `Ulusal Kanallar`, `Canlı Haber`, `Sinema Kanalları`, `Belgesel & Çocuk`, `Müzik & Eğlence`, `Yerel & Diğer`) tek `anthology-tv` eklentisinde birleştirilmiştir; sahte/uydurma EPG tabloları içermez.
  - `settingsSchema` üzerinden `anthologyLiveUrl`, `anthologyLiveUsername`, gizli `anthologyLivePassword` ve `preferredSportSource` desteklenir.
- **Birleşik TMDB Motoru (`anthology-plus` / `Anthology+`)**:
  - Önceden TMDB kataloğuna bağımlı olan `vidlink`, `vidmody` ve `anthology-m3u` eklentileri tek `anthology-plus` eklentisinde birleştirilmiştir ve yalnızca TMDB/IMDb kimliği kesin eşleşen ikincil kaynakları (`hdfilmdelisi`, `sinemacx`, `animecix`, `seicode`, `sonanime`) paralel sorgular.
  - `settingsSchema` üzerinden 8 `toggle` anahtarı (`enableVixolity`, `enableGoVod`, `enableVidlink`, `enableHdFilmDelisi`, `enableSinemaCx`, `enableAnimecix`, `enableSeicode`, `enableSonAnime`) ve 2 adres ayarı (`anthologyLiveUrl`, `vidlinkMirror`) desteklenir.

### 5. Doğrulama Komutları
- **Tam senkron + tip kontrol + şema + birim testi**: `npm test` (`sync && typecheck && validate && test:unit`)
- **Canlı smoke testi (tümü veya seçili eklenti)**: `npm run test:smoke` veya `npm run test:smoke -- anthology-tv anthology-plus anizium`
- **Paketleme testi (`.plugin.vessel` → gitignore altındaki `dist/`)**: `npm run pack`
- **Not**: `sinewix` Anthology tarafında devre dışı bırakıldığı için, TMDB tabanlı `vidlink`/`vidmody`/`anthology-m3u` ise `anthology-plus` içinde birleştirildiği için depoda **33 aktif eklenti** (`1` Canlı TV + `1` Anthology+ + `9` film/karma + `14` dizi/TV ağı + `8` anime) yönetilir.

## Devam Noktası
- **TEK `plugins/` DÜZENİ VE `Anthology+` BİRLEŞTİRME TAMAMLANDI (sürüm 1.0.0 — 33 Eklenti)**:
  - İki ayrı `src/plugins/` ve `plugins/` kopyası kaldırılarak `core/`, `extractors/` ve tek kanonik `plugins/<id>/` yapısına geçildi (`scripts/sync-plugins.ts` paylaşımı yerinde senkronize eder, `channels-data.ts` ve `repo.json` dosyalarını üretir).
  - `core/exact-tmdb-sources.ts` üzerinden TMDB/IMDb kesin eşleşmeli yardımcılar tek noktada toplandı (`hdfilmdelisi`, `sinemacx`, `animecix`, `seicode`, `sonanime` kod tekrarı olmadan paylaşır).
  - `vidlink`, `vidmody` ve `anthology-m3u` birleştirilip `plugins/anthology-plus/` (`Anthology+`) eklentisi `8` adet `toggle` ve `2` adet sunucu adresi içeren `settingsSchema` ile oluşturuldu.
  - Gerçek **Vessel** Rust çalışma zamanı (`oxc` + `rquickjs`) doğrulamasında **33 / 33** eklenti hatasız yüklendi ve `anthology-tv` canlı `home_feed` (7 kategori / 388 kanal) döndü.
  - `Anthology+` canlı film/dizi/anime ve tüm-toggle-kapalı testleri geçti; `animecix` `res.url` yönlendirme hatası (`safeRequest`) onarılarak `animecix` (`Death Note`, 2 akış) ve `anthology-plus` (`Başlangıç`, `Breaking Bad`, `Solo Leveling`, `Death Note`) canlı doğrulandı.
  - `anthology` reposundaki `index.html` ve `README.md` 33 eklenti + `Anthology+` bilgisiyle güncellenerek `f9bb55f` (`docs(website): add native Vessel TypeScript repo reference`) commit'iyle push'landı.
