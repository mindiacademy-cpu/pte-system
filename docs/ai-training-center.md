# Mindi Academy — AI Eğitim Merkezi (v1)

## Amaç
Admin panelinden Writing ve Speaking yanıtlarına uzman puanı ve açıklaması eklemek, onaylı ve kimliksizleştirilmiş eğitim örnekleri oluşturmak. Mevcut sınav puanlaması ve raporları bu ilk aşamada değiştirilmeyecektir.

## Mevcut sistemle entegrasyon
- Supabase `exam_results` tablosunda `answers`, `summary`, `evaluation` bulunuyor.
- `PUT /exam-results/:resultId/manual-score` mevcut sınav sonucunu yeniden hesaplar; eğitim etiketi olarak kullanılmamalıdır.
- Yeni eğitim kayıtları ayrı tabloda tutulmalı; canlı sınav sonucundan bağımsız olmalıdır.
- Eğitim verisine erişim yalnızca yetkili admin/uzman rollerinde olmalıdır.

## Yeni veri modeli (öneri)
`ai_training_reviews`:
- id (uuid), result_id, question_id, question_type
- response_text_redacted, audio_private_object_key (opsiyonel)
- model_score, expert_score, expert_feedback
- rubric_version, model_version, reviewed_by, reviewed_at
- approval_status (draft|approved|rejected), consent_basis, created_at, updated_at

## Ekranlar
1. İnceleme kuyruğu: soru tipi, mevcut AI puanı, değerlendirme durumu; aday kimlikleri gösterilmez.
2. Cevap inceleme: soru yönergesi, aday yanıtı/ses kaydı (yetkili erişim), mevcut AI değerlendirmesi, uzman puanı ve gerekçesi.
3. Onay: taslak kaydet, ikinci uzman kontrolü, eğitim örneği olarak onayla/reddet.
4. Veri seti: onaylı örnek sayısı, soru tipine göre dağılım, kimliksiz JSONL dışa aktarımı.
5. Model sürümleri: eğitim işinin durumu, test metrikleri, önceki sürüme dönüş (ayrı faz).

## Güvenlik ve veri kalitesi
- Adayın açık rızası veya uygun hukuki dayanak, saklama süresi ve silme mekanizması doğrulanmalı.
- Kimlik, telefon, e-posta, sınav kodu ve serbest metindeki kişisel bilgiler eğitim dışa aktarımından çıkarılmalı.
- Ses dosyaları herkese açık `/uploads` üzerinden değil, özel depolama ve süreli erişim ile sunulmalı.
- Gerçek sınav sonucu ile deneme sınavı eşleştirmesi ayrı izinli tabloda tutulmalı.
- Eğitim/test aday bazında ayrılmalı; aynı adayın yanıtları iki sete dağılmamalı.
- AI puanı eğitimde altın standart kabul edilmemeli; uzman değerlendirmesi gerekli.

## Kabul kriterleri
- Uzman puan düzeltmesi canlı `summary` değerini değiştirmez.
- Taslak/onaylı örnekler ayrı ayrı listelenir; sadece onaylı örnekler dışa aktarılır.
- Dışa aktarılan dosyada aday kimliği ve erişilebilir ses URL'si yoktur.
- Her örnek puanlama rubriği ve model sürümüne bağlanır.
- Admin olmayan kullanıcı eğitim örneklerini okuyamaz/değiştiremez.
- Eğitim süreci yalnızca açık yönetici onayıyla başlatılır.

## Uygulama sırası
1. Supabase migration + RLS ve izinler
2. Admin API uç noktaları + doğrulama + audit log
3. Yönetici paneli UI
4. Kimliksiz dışa aktarım + testler
5. Uzman etiketleme pilotu
6. Fine-tuning ve bağımsız karşılaştırmalı değerlendirme

**Not:** Bu dosya bir uygulama tasarımıdır; henüz çalışan panel veya fine-tuning entegrasyonu değildir.
