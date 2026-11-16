library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Any port you leave out is simply not connected.
entity top is
  port (
    CLOCK_50 : in  std_logic;                       -- 50 MHz clock (speed set in toolbar)
    SW       : in  std_logic_vector(17 downto 0);   -- slide switches
    KEY      : in  std_logic_vector(3 downto 0);    -- push buttons, '0' when pressed
    LEDR     : out std_logic_vector(17 downto 0);   -- red LEDs
    LEDG     : out std_logic_vector(8 downto 0);    -- green LEDs
    HEX0     : out std_logic_vector(6 downto 0)     -- 7-seg, active low, "gfedcba"
  );
end entity;

architecture rtl of top is
begin
  LEDR <= SW;
  LEDG <= (others => '0');
  HEX0 <= (others => '1');
end architecture;
