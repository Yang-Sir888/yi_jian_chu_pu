-- 国韵谱音 · 服务端数据访问函数
-- 平台只给后端开放「单条语句」通道（无连接串、无跨语句事务），因此把每个
-- 需要原子性的业务动作封装成一个 SECURITY DEFINER 函数：函数内部开事务、
-- 做乐观版本校验、写作品与音频清理队列，一次调用完成。
-- 这些函数只授予服务端角色，前端（anon / authenticated）无权调用。

-- 服务端配置表（模型密钥等加密后存放），由后端 ensureSchema 保证存在。
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION lingpu_save_work(
  p_id uuid, p_owner uuid, p_version integer, p_payload jsonb,
  p_audio_key text, p_audio_type text, p_audio_name text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  old works;
  next_version integer;
  new_id uuid;
  keep_new boolean := p_audio_key IS NOT NULL;
BEGIN
  IF p_id IS NOT NULL THEN
    SELECT * INTO old FROM works WHERE id = p_id AND owner_id = p_owner FOR UPDATE;
    IF NOT FOUND THEN
      RETURN json_build_object('status', 'missing');
    END IF;
    IF old.version <> p_version THEN
      RETURN json_build_object('status', 'conflict', 'version', old.version);
    END IF;
    next_version := old.version + 1;
    UPDATE works SET
      version = next_version,
      payload = p_payload,
      audio_key = COALESCE(p_audio_key, audio_key),
      audio_type = COALESCE(p_audio_type, audio_type),
      audio_name = COALESCE(p_audio_name, audio_name),
      updated_at = now()
    WHERE id = old.id;
    new_id := old.id;
    IF keep_new AND old.audio_key IS NOT NULL AND old.audio_key <> p_audio_key THEN
      INSERT INTO blob_cleanup(key) VALUES (old.audio_key) ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    new_id := COALESCE((p_payload->>'id')::uuid, gen_random_uuid());
    next_version := 1;
    INSERT INTO works(id, owner_id, version, payload, audio_key, audio_type, audio_name)
    VALUES (new_id, p_owner, next_version, p_payload, p_audio_key, p_audio_type, p_audio_name);
  END IF;

  IF keep_new THEN
    DELETE FROM blob_cleanup WHERE key = p_audio_key;
  END IF;

  RETURN json_build_object(
    'status', 'ok',
    'id', new_id,
    'version', next_version,
    'audioKey', COALESCE(p_audio_key, old.audio_key)
  );
END $fn$;

CREATE OR REPLACE FUNCTION lingpu_delete_work(p_id uuid, p_owner uuid)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  removed works;
BEGIN
  DELETE FROM works WHERE id = p_id AND owner_id = p_owner RETURNING * INTO removed;
  IF NOT FOUND THEN
    RETURN json_build_object('status', 'missing');
  END IF;
  IF removed.audio_key IS NOT NULL THEN
    INSERT INTO blob_cleanup(key) VALUES (removed.audio_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN json_build_object('status', 'ok');
END $fn$;

CREATE OR REPLACE FUNCTION lingpu_set_password(p_id uuid, p_hash text, p_must_change boolean)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  UPDATE users SET password_hash = p_hash, must_change = p_must_change WHERE id = p_id;
  DELETE FROM sessions WHERE user_id = p_id;
  RETURN json_build_object('status', 'ok');
END $fn$;

CREATE OR REPLACE FUNCTION lingpu_set_disabled(p_id uuid, p_flag boolean)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  UPDATE users SET disabled = p_flag WHERE id = p_id;
  DELETE FROM sessions WHERE user_id = p_id;
  RETURN json_build_object('status', 'ok');
END $fn$;

CREATE OR REPLACE FUNCTION lingpu_add_session(p_hash text, p_user uuid, p_csrf text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  DELETE FROM sessions WHERE expires_at < now();
  INSERT INTO sessions(token_hash, user_id, csrf, expires_at)
  VALUES (p_hash, p_user, p_csrf, now() + interval '8 hours');
  RETURN json_build_object('status', 'ok');
END $fn$;

CREATE OR REPLACE FUNCTION lingpu_session(p_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  row_data json;
BEGIN
  SELECT to_jsonb(u) || jsonb_build_object('csrf', s.csrf) INTO row_data
  FROM sessions s JOIN users u ON s.user_id = u.id
  WHERE s.token_hash = p_hash AND s.expires_at > now() AND u.disabled = false;
  RETURN row_data;
END $fn$;

CREATE OR REPLACE FUNCTION lingpu_garbage()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
DECLARE
  keys json;
BEGIN
  SELECT COALESCE(json_agg(key), '[]'::json) INTO keys FROM (
    SELECT key FROM blob_cleanup
    WHERE due_at <= now()
      AND NOT EXISTS (SELECT 1 FROM works w WHERE w.audio_key = blob_cleanup.key)
    LIMIT 100
  ) pending;
  RETURN keys;
END $fn$;

CREATE OR REPLACE FUNCTION lingpu_audio_size()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  RETURN json_build_object('bytes', (SELECT COALESCE(SUM(octet_length(data)), 0) FROM audio_blobs));
END $fn$;

CREATE OR REPLACE FUNCTION lingpu_set_setting(p_key text, p_value jsonb)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $fn$
BEGIN
  INSERT INTO app_settings(key, value) VALUES (p_key, p_value)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  RETURN json_build_object('status', 'ok');
END $fn$;

-- 只有服务端角色可以执行；浏览器侧的 anon / authenticated 一律拒绝。
DO $grant$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'lingpu_save_work(uuid,uuid,integer,jsonb,text,text,text)',
    'lingpu_delete_work(uuid,uuid)',
    'lingpu_set_password(uuid,text,boolean)',
    'lingpu_set_disabled(uuid,boolean)',
    'lingpu_add_session(text,uuid,text)',
    'lingpu_session(text)',
    'lingpu_garbage()',
    'lingpu_audio_size()',
    'lingpu_set_setting(text,jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $grant$;
