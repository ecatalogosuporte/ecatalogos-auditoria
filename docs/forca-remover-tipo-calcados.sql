-- Consolidar NACIONAL (Marca Calçados) em NACIONAL.
-- Executar no MySQL do Força de vendas conectado à Auditoria, empresa de chave 2000.
-- Não executar no Supabase. Não há credenciais neste arquivo.
-- Os produtos disponíveis já foram transferidos pela API.
-- Este complemento move vínculos restantes, inclusive de produtos arquivados,
-- e só então remove o tipo antigo. Não exclui nem restaura produtos.
-- Estoques, preços, imagens, variantes e demais campos não são alterados.

DROP PROCEDURE IF EXISTS auditoria_consolidar_nacional_20261118;
DELIMITER //
CREATE PROCEDURE auditoria_consolidar_nacional_20261118()
BEGIN
  DECLARE company_id_checked INT DEFAULT NULL;
  DECLARE source_id INT DEFAULT NULL;
  DECLARE target_id INT DEFAULT NULL;
  DECLARE products_moved INT DEFAULT 0;
  DECLARE regions_moved INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;
  SELECT id INTO company_id_checked FROM companies
    WHERE id = 514 AND `key` = 2000 AND erp_id = '2000' AND deleted_at IS NULL
    FOR UPDATE;
  IF company_id_checked IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Empresa divergente. Nenhuma alteracao.';
  END IF;

  SELECT id INTO source_id FROM branches
    WHERE id = 37 AND company_id = company_id_checked
      AND erp_id = 'FEIRA-BR-NAC' AND TRIM(name) = 'NACIONAL (Marca Calçados)'
    FOR UPDATE;
  SELECT id INTO target_id FROM branches
    WHERE id = 28 AND company_id = company_id_checked
      AND erp_id = '001' AND TRIM(name) = 'NACIONAL'
    FOR UPDATE;
  IF source_id IS NULL OR target_id IS NULL OR source_id = target_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tipos de origem/destino divergentes ou tipo antigo ja removido.';
  END IF;

  -- Sem filtro deleted_at: preserva a exclusão lógica, mas transfere o vínculo.
  UPDATE products SET branch_id = target_id
    WHERE company_id = company_id_checked AND branch_id = source_id;
  SET products_moved = ROW_COUNT();

  -- Regiões também possuem chave estrangeira para o tipo/filial.
  UPDATE regions SET branch_id = target_id
    WHERE company_id = company_id_checked AND branch_id = source_id;
  SET regions_moved = ROW_COUNT();

  IF EXISTS (SELECT 1 FROM products WHERE branch_id = source_id)
    OR EXISTS (SELECT 1 FROM regions WHERE branch_id = source_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Restam vinculos fora da empresa; operacao revertida.';
  END IF;

  DELETE FROM branches
    WHERE id = source_id AND company_id = company_id_checked
      AND erp_id = 'FEIRA-BR-NAC';
  IF ROW_COUNT() <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tipo antigo nao removido; operacao revertida.';
  END IF;

  COMMIT;
  SELECT products_moved AS vinculos_produtos_transferidos,
    regions_moved AS vinculos_regioes_transferidos,
    'NACIONAL (Marca Calçados) removido' AS resultado;
END//
DELIMITER ;
CALL auditoria_consolidar_nacional_20261118();
DROP PROCEDURE auditoria_consolidar_nacional_20261118;
