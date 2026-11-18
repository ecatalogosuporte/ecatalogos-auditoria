-- eCatalogos Auditoria: vincular os 56 cadastros enviados em 18/11/2026.
-- Executar no MySQL do Força de vendas TEST/DEV, empresa de chave 2000.
-- Este arquivo NAO deve ser executado no Supabase.
-- Preenche apenas erp_id vazio com o ID interno enviado pelo responsável.
-- Mantém códigos ERP existentes, nomes, marcas das categorias e todos os produtos.
-- Valida empresa, IDs e nomes antes de gravar; erro provoca ROLLBACK.
-- Não usa INSERT nas tabelas de negócio nem apaga cadastros.
-- O usuário do banco precisa poder criar/excluir esta rotina temporária.
SET NAMES utf8mb4;

DROP PROCEDURE IF EXISTS auditoria_vincular_catalogo_20261118;
DELIMITER //
CREATE PROCEDURE auditoria_vincular_catalogo_20261118()
BEGIN
  DECLARE target_company INT DEFAULT NULL;
  DECLARE matched_rows INT DEFAULT 0;
  DECLARE changed_rows INT DEFAULT 0;
  DECLARE remaining_rows INT DEFAULT 0;
  DECLARE current_count INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    DROP TEMPORARY TABLE IF EXISTS auditoria_catalogo_20261118;
    RESIGNAL;
  END;

  CREATE TEMPORARY TABLE auditoria_catalogo_20261118 (
    kind VARCHAR(16) NOT NULL,
    internal_id INT NOT NULL,
    expected_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (kind, internal_id)
  );
  INSERT INTO auditoria_catalogo_20261118 (kind, internal_id, expected_name) VALUES
    ('branches', 28, 'NACIONAL'),
    ('branches', 29, 'IMPORTADO'),
    ('branches', 37, 'NACIONAL (Marca Calçados)'),
    ('brands', 578, 'Visari'),
    ('brands', 580, 'Pueri'),
    ('brands', 581, 'Moda infantil'),
    ('brands', 583, 'Moda Adulto'),
    ('brands', 590, 'Exposec LTDA'),
    ('brands', 591, 'NaturalTech'),
    ('brands', 601, 'Musical Instrumentos'),
    ('brands', 602, 'Beleza Beauty'),
    ('brands', 603, 'Cozzari'),
    ('brands', 604, 'Parfums'),
    ('brands', 605, 'Vellune'),
    ('brands', 624, 'Higiexpo'),
    ('brands', 625, 'Higiene e Limpeza'),
    ('brands', 626, 'Moda Masculina'),
    ('brands', 627, 'Moda Feminina'),
    ('brands', 628, 'Moda Acessorios'),
    ('brands', 646, 'Marca Calçados'),
    ('brands', 647, 'Calçados Infantis'),
    ('brands', 648, 'Calçados Femininos'),
    ('brands', 649, 'Calçados Masculinos'),
    ('brands', 650, 'Demonstração Auditoria'),
    ('categories', 279, 'Óculos de sol'),
    ('categories', 280, 'Óculos de grau'),
    ('categories', 281, 'Roupas Bebê'),
    ('categories', 282, 'Roupas infantil'),
    ('categories', 283, 'Brinquedos'),
    ('categories', 284, 'Carrinho de Bebê'),
    ('categories', 285, 'Chupetas'),
    ('categories', 286, 'Mamadeiras'),
    ('categories', 287, 'Material de Higiene'),
    ('categories', 288, 'Roupas masculinas'),
    ('categories', 289, 'Roupas feminina'),
    ('categories', 292, 'Câmeras'),
    ('categories', 293, 'Fechadura Digital'),
    ('categories', 294, 'Energéticos'),
    ('categories', 295, 'Produtos Naturais'),
    ('categories', 296, 'Suplementos'),
    ('categories', 301, 'Violão'),
    ('categories', 302, 'Violino'),
    ('categories', 303, 'Utensílios de cozinha'),
    ('categories', 304, 'Perfumes'),
    ('categories', 305, 'Instrumentos musicais'),
    ('categories', 306, 'Beleza'),
    ('categories', 343, 'Calçados'),
    ('categories', 344, 'Vestuário'),
    ('categories', 345, 'Ferramentas e Acessórios'),
    ('categories', 346, 'Limpeza'),
    ('categories', 347, 'Eletrodomésticos'),
    ('categories', 348, 'Jardim e Ferramentas'),
    ('categories', 381, 'Bolsas'),
    ('categories', 382, 'Calçados'),
    ('categories', 383, 'Pijamas — Demonstração'),
    ('categories', 384, 'Calçados');

  START TRANSACTION;
  SELECT id INTO target_company FROM companies
    WHERE `key` = 2000 AND erp_id = '2000' AND deleted_at IS NULL FOR UPDATE;
  IF target_company IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Empresa de chave 2000 e ERP 2000 nao encontrada; nenhuma alteracao.';
  END IF;

  -- Bloqueia os registros e retorna os valores atuais para conferência.
  SELECT 'branches' AS cadastro, t.id, t.name, t.erp_id AS erp_anterior
    FROM branches t JOIN auditoria_catalogo_20261118 m ON m.kind = 'branches' AND m.internal_id = t.id
    WHERE t.company_id = target_company ORDER BY t.id FOR UPDATE;
  SELECT 'brands' AS cadastro, t.id, t.name, t.erp_id AS erp_anterior
    FROM brands t JOIN auditoria_catalogo_20261118 m ON m.kind = 'brands' AND m.internal_id = t.id
    WHERE t.company_id = target_company ORDER BY t.id FOR UPDATE;
  SELECT 'categories' AS cadastro, t.id, t.name, t.erp_id AS erp_anterior
    FROM categories t JOIN auditoria_catalogo_20261118 m ON m.kind = 'categories' AND m.internal_id = t.id
    WHERE t.company_id = target_company ORDER BY t.id FOR UPDATE;

  SELECT COUNT(*) INTO current_count
    FROM branches t JOIN auditoria_catalogo_20261118 m ON m.kind = 'branches' AND m.internal_id = t.id
    WHERE t.company_id = target_company AND BINARY TRIM(t.name) = BINARY m.expected_name;
  SET matched_rows = matched_rows + current_count;
  SELECT COUNT(*) INTO current_count
    FROM brands t JOIN auditoria_catalogo_20261118 m ON m.kind = 'brands' AND m.internal_id = t.id
    WHERE t.company_id = target_company AND BINARY TRIM(t.name) = BINARY m.expected_name AND t.deleted_at IS NULL;
  SET matched_rows = matched_rows + current_count;
  SELECT COUNT(*) INTO current_count
    FROM categories t JOIN auditoria_catalogo_20261118 m ON m.kind = 'categories' AND m.internal_id = t.id
    WHERE t.company_id = target_company AND BINARY TRIM(t.name) = BINARY m.expected_name;
  SET matched_rows = matched_rows + current_count;
  IF matched_rows <> 56 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IDs, nomes ou empresa divergem da lista enviada. Nenhuma alteracao.';
  END IF;

  UPDATE branches t
    JOIN auditoria_catalogo_20261118 m ON m.kind = 'branches' AND m.internal_id = t.id
    SET t.erp_id = CAST(t.id AS CHAR)
    WHERE t.company_id = target_company AND (t.erp_id IS NULL OR TRIM(t.erp_id) = '');
  SET changed_rows = changed_rows + ROW_COUNT();

  UPDATE brands t
    JOIN auditoria_catalogo_20261118 m ON m.kind = 'brands' AND m.internal_id = t.id
    SET t.erp_id = CAST(t.id AS CHAR)
    WHERE t.company_id = target_company AND (t.erp_id IS NULL OR TRIM(t.erp_id) = '');
  SET changed_rows = changed_rows + ROW_COUNT();

  UPDATE categories t
    JOIN auditoria_catalogo_20261118 m ON m.kind = 'categories' AND m.internal_id = t.id
    SET t.erp_id = CAST(t.id AS CHAR)
    WHERE t.company_id = target_company AND (t.erp_id IS NULL OR TRIM(t.erp_id) = '');
  SET changed_rows = changed_rows + ROW_COUNT();

  SELECT COUNT(*) INTO current_count
    FROM branches t JOIN auditoria_catalogo_20261118 m ON m.kind = 'branches' AND m.internal_id = t.id
    WHERE t.company_id = target_company AND (t.erp_id IS NULL OR TRIM(t.erp_id) = '');
  SET remaining_rows = remaining_rows + current_count;
  SELECT COUNT(*) INTO current_count
    FROM brands t JOIN auditoria_catalogo_20261118 m ON m.kind = 'brands' AND m.internal_id = t.id
    WHERE t.company_id = target_company AND (t.erp_id IS NULL OR TRIM(t.erp_id) = '');
  SET remaining_rows = remaining_rows + current_count;
  SELECT COUNT(*) INTO current_count
    FROM categories t JOIN auditoria_catalogo_20261118 m ON m.kind = 'categories' AND m.internal_id = t.id
    WHERE t.company_id = target_company AND (t.erp_id IS NULL OR TRIM(t.erp_id) = '');
  SET remaining_rows = remaining_rows + current_count;
  IF remaining_rows <> 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Existem codigos ERP vazios apos a gravacao. Alteracoes revertidas.';
  END IF;

  COMMIT;
  SELECT target_company AS empresa_id, 56 AS cadastros_conferidos, changed_rows AS codigos_preenchidos, 'OK' AS resultado;

  SELECT 'branches' AS cadastro, t.id, t.name, t.erp_id
    FROM branches t JOIN auditoria_catalogo_20261118 m ON m.kind = 'branches' AND m.internal_id = t.id
    WHERE t.company_id = target_company ORDER BY t.id;
  SELECT 'brands' AS cadastro, t.id, t.name, t.erp_id
    FROM brands t JOIN auditoria_catalogo_20261118 m ON m.kind = 'brands' AND m.internal_id = t.id
    WHERE t.company_id = target_company ORDER BY t.id;
  SELECT 'categories' AS cadastro, t.id, t.name, t.erp_id
    FROM categories t JOIN auditoria_catalogo_20261118 m ON m.kind = 'categories' AND m.internal_id = t.id
    WHERE t.company_id = target_company ORDER BY t.id;

  -- Categorias sem brand_id precisam de conferência do responsável: não adivinhamos a marca.
  SELECT c.id, c.name, c.erp_id, c.brand_id, b.name AS marca, b.erp_id AS marca_erp
    FROM categories c
    JOIN auditoria_catalogo_20261118 m ON m.kind = 'categories' AND m.internal_id = c.id
    LEFT JOIN brands b ON b.id = c.brand_id
    WHERE c.company_id = target_company ORDER BY c.id;

  DROP TEMPORARY TABLE auditoria_catalogo_20261118;
END//
DELIMITER ;
CALL auditoria_vincular_catalogo_20261118();
DROP PROCEDURE auditoria_vincular_catalogo_20261118;
